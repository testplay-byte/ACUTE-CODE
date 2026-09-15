// @vitest-environment happy-dom
/**
 * ROUND-99 (R99-A) — the CENTRAL LINK ROUTER's decision matrix, pinned leg
 * by leg (the owner directive: the app's links open in the app's OWN
 * browser unless the user says otherwise — never a dead `<a target=_blank>`
 * swallowed by WebView2, never an unsolicited jump to the device browser):
 *
 *  · the SCHEME GATE — http/https only; mailto/file/javascript/refusees
 *    and unparseable strings return honest refusals (never guessed);
 *  · the PREFERENCE — linkOpeningMode "in-app" (default) lands the link in
 *    the active project's sidebar browser tab; "system" hands it to the OS
 *    browser via window.open in web mode / open_external_url in Tauri mode;
 *  · the PROJECT RESOLUTION — opts.projectId override > the project-chat
 *    store's activeProjectId > the right-sidebar store's;
 *  · the NO-PROJECT fallback — a global surface with no project context
 *    degrades honestly to the system browser;
 *  · the STORE-THROW fallback — the browser-tab store throwing never kills
 *    the click (the link still opens, system leg, reason said);
 *  · the WEB-MODE fallback — window.open only when window.__TAURI__ is
 *    absent; the Tauri leg rides the open_external_url command and reports
 *    its failures honestly;
 *  · the CACHE — setLinkOpeningMode pushes live; the memoized
 *    hydrateLinkOpeningMode seeds from GET /settings/browser exactly once,
 *    keeps the default on failure, and never trusts a bad wire value.
 *
 * The router holds module-level state (the preference cache + the hydration
 * memo), so every test re-imports a FRESH module graph via vi.resetModules()
 * + dynamic import (the desktop-notifications.test.ts pattern) — the stores
 * come along fresh, their localStorage cleared before each re-import.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
});

/** A fresh router + the fresh stores it resolved (one module registry). */
async function freshRouter() {
  window.localStorage.clear();
  vi.resetModules();
  const mod = await import("./open-link");
  const { useProjectChatStore } = await import("./project-chat-store");
  const { useRightSidebarStore } = await import("./right-sidebar-store");
  return {
    openLink: mod.openLink,
    setLinkOpeningMode: mod.setLinkOpeningMode,
    getLinkOpeningMode: mod.getLinkOpeningMode,
    hydrateLinkOpeningMode: mod.hydrateLinkOpeningMode,
    useProjectChatStore,
    useRightSidebarStore,
  };
}

/** The web-mode window.open spy (no __TAURI__ global installed). */
function stubWindowOpen(): ReturnType<typeof vi.fn> {
  const openSpy = vi.fn();
  vi.stubGlobal("open", openSpy);
  return openSpy;
}

/** The Tauri shell stub: records invoke commands, answers undefined. */
function stubTauri(): { invoke: ReturnType<typeof vi.fn> } {
  const invoke = vi.fn(async () => undefined);
  vi.stubGlobal("__TAURI__", { core: { invoke } });
  return { invoke };
}

/** A minimal Response for the api request() helper (status/ok/text). */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const URL_OK = "https://example.com/docs";

describe("open-link: the scheme gate (http/https ONLY, never guessed)", () => {
  it("a non-http(s) scheme is refused with the honest reason — no window.open, no store call", async () => {
    const { openLink, useRightSidebarStore } = await freshRouter();
    const openSpy = stubWindowOpen();
    const openBrowser = vi.fn(() => "tab_x");
    useRightSidebarStore.setState({ openBrowser });

    for (const bad of ["mailto:someone@example.com", "file:///C:/x.html", "javascript:alert(1)", "ftp://mirror.example.com"]) {
      const result = await openLink(bad);
      expect(result).toEqual({ outcome: "refused", url: bad, reason: "scheme" });
    }
    expect(openSpy).not.toHaveBeenCalled();
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it("an unparseable or scheme-relative string is refused as invalid-url", async () => {
    const { openLink } = await freshRouter();
    for (const bad of ["not a url at all", "/relative/path", "#anchor", ""]) {
      const result = await openLink(bad);
      expect(result).toEqual({ outcome: "refused", url: bad, reason: "invalid-url" });
    }
  });

  it("an uppercase HTTPS scheme passes the gate (WHATWG protocol normalization)", async () => {
    const { openLink, useProjectChatStore, useRightSidebarStore } = await freshRouter();
    useProjectChatStore.setState({ activeProjectId: "prj_chat" });
    const openBrowser = vi.fn(() => "tab_up");
    useRightSidebarStore.setState({ openBrowser });

    const result = await openLink("HTTPS://EXAMPLE.COM/PAGE");
    expect(result.outcome).toBe("in-app");
    expect(openBrowser).toHaveBeenCalledWith("prj_chat", "HTTPS://EXAMPLE.COM/PAGE");
  });
});

describe("open-link: the preference legs", () => {
  it("'in-app' (the DEFAULT) opens the link in the ACTIVE project's sidebar browser tab", async () => {
    const { openLink, useProjectChatStore, useRightSidebarStore } = await freshRouter();
    const openSpy = stubWindowOpen();
    useProjectChatStore.setState({ activeProjectId: "prj_chat" });
    const openBrowser = vi.fn(() => "tab_probe");
    useRightSidebarStore.setState({ openBrowser });

    const result = await openLink(URL_OK);
    expect(result).toEqual({ outcome: "in-app", url: URL_OK, projectId: "prj_chat", tabId: "tab_probe" });
    expect(openBrowser).toHaveBeenCalledTimes(1);
    expect(openBrowser).toHaveBeenCalledWith("prj_chat", URL_OK);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("'system' hands the link to the OS browser (web mode: window.open with _blank/noreferrer)", async () => {
    const { openLink, setLinkOpeningMode } = await freshRouter();
    const openSpy = stubWindowOpen();
    setLinkOpeningMode("system");

    const result = await openLink(URL_OK);
    expect(result).toEqual({ outcome: "system", url: URL_OK, reason: "preference", via: "window-open" });
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(URL_OK, "_blank", "noreferrer");
  });

  it("'system' inside the Tauri shell rides the open_external_url command — never window.open", async () => {
    const { openLink, setLinkOpeningMode } = await freshRouter();
    const { invoke } = stubTauri();
    setLinkOpeningMode("system");

    const result = await openLink(URL_OK);
    expect(result).toEqual({ outcome: "system", url: URL_OK, reason: "preference", via: "tauri" });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("open_external_url", { url: URL_OK });
  });

  it("forceExternal is the deliberate escape hatch — it beats the in-app preference AND an active project", async () => {
    const { openLink, useProjectChatStore, useRightSidebarStore } = await freshRouter();
    const openSpy = stubWindowOpen();
    useProjectChatStore.setState({ activeProjectId: "prj_chat" });
    const openBrowser = vi.fn(() => "tab_never");
    useRightSidebarStore.setState({ openBrowser });

    const result = await openLink(URL_OK, { forceExternal: true });
    expect(result).toEqual({ outcome: "system", url: URL_OK, reason: "force-external", via: "window-open" });
    expect(openSpy).toHaveBeenCalledWith(URL_OK, "_blank", "noreferrer");
    expect(openBrowser).not.toHaveBeenCalled();
  });
});

describe("open-link: the project resolution chain", () => {
  it("opts.projectId overrides both stores", async () => {
    const { openLink, useProjectChatStore, useRightSidebarStore } = await freshRouter();
    useProjectChatStore.setState({ activeProjectId: "prj_chat" });
    useRightSidebarStore.setState({ activeProjectId: "prj_side" });
    const openBrowser = vi.fn(() => "tab_override");
    useRightSidebarStore.setState({ openBrowser });

    const result = await openLink(URL_OK, { projectId: "prj_explicit" });
    expect(result).toEqual({ outcome: "in-app", url: URL_OK, projectId: "prj_explicit", tabId: "tab_override" });
    expect(openBrowser).toHaveBeenCalledWith("prj_explicit", URL_OK);
  });

  it("falls back to the RIGHT-SIDEBAR store's active project when the chat store has none", async () => {
    const { openLink, useProjectChatStore, useRightSidebarStore } = await freshRouter();
    useProjectChatStore.setState({ activeProjectId: null });
    useRightSidebarStore.setState({ activeProjectId: "prj_side" });
    const openBrowser = vi.fn(() => "tab_side");
    useRightSidebarStore.setState({ openBrowser });

    const result = await openLink(URL_OK);
    expect(result).toEqual({ outcome: "in-app", url: URL_OK, projectId: "prj_side", tabId: "tab_side" });
  });

  it("NO project context (a global surface on a fresh boot) degrades to the system browser, honestly", async () => {
    const { openLink, useProjectChatStore, useRightSidebarStore } = await freshRouter();
    const openSpy = stubWindowOpen();
    useProjectChatStore.setState({ activeProjectId: null });
    useRightSidebarStore.setState({ activeProjectId: null });
    const openBrowser = vi.fn(() => "tab_never");
    useRightSidebarStore.setState({ openBrowser });

    const result = await openLink(URL_OK);
    expect(result).toEqual({ outcome: "system", url: URL_OK, reason: "no-project", via: "window-open" });
    expect(openSpy).toHaveBeenCalledWith(URL_OK, "_blank", "noreferrer");
    expect(openBrowser).not.toHaveBeenCalled();
  });
});

describe("open-link: the failure fallbacks", () => {
  it("a browser-tab store THROW never kills the click — the system leg catches it, reason said", async () => {
    const { openLink, useProjectChatStore, useRightSidebarStore } = await freshRouter();
    const openSpy = stubWindowOpen();
    useProjectChatStore.setState({ activeProjectId: "prj_chat" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    useRightSidebarStore.setState({
      openBrowser: vi.fn(() => {
        throw new Error("corrupt slice");
      }),
    });

    const result = await openLink(URL_OK);
    expect(result).toEqual({ outcome: "system", url: URL_OK, reason: "store-error", via: "window-open" });
    expect(openSpy).toHaveBeenCalledWith(URL_OK, "_blank", "noreferrer");
    expect(warnSpy).toHaveBeenCalled();
  });

  it("an open_external_url REJECTION inside the shell is reported honestly (outcome error)", async () => {
    const { openLink, setLinkOpeningMode } = await freshRouter();
    const invoke = vi.fn(async () => {
      throw new Error("shell refused");
    });
    vi.stubGlobal("__TAURI__", { core: { invoke } });
    setLinkOpeningMode("system");

    const result = await openLink(URL_OK);
    expect(result).toEqual({
      outcome: "error",
      url: URL_OK,
      reason: "external-open-failed",
      message: "shell refused",
    });
  });
});

describe("open-link: the preference cache + hydration", () => {
  it("setLinkOpeningMode pushes LIVE — the very next click obeys (no restart)", async () => {
    const { openLink, setLinkOpeningMode, useProjectChatStore, useRightSidebarStore } = await freshRouter();
    const openSpy = stubWindowOpen();
    useProjectChatStore.setState({ activeProjectId: "prj_chat" });
    const openBrowser = vi.fn(() => "tab_probe");
    useRightSidebarStore.setState({ openBrowser });

    expect((await openLink(URL_OK)).outcome).toBe("in-app");
    setLinkOpeningMode("system");
    const second = await openLink(URL_OK);
    expect(second).toMatchObject({ outcome: "system", reason: "preference" });
    setLinkOpeningMode("in-app");
    expect((await openLink(URL_OK)).outcome).toBe("in-app");
    expect(openBrowser).toHaveBeenCalledTimes(2);
    expect(openSpy).toHaveBeenCalledTimes(1);
  });

  it("hydrateLinkOpeningMode seeds the cache from GET /settings/browser — memoized to ONE fetch", async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse({
        searchEngine: "duckduckgo",
        homepage: "acute://home",
        defaultZoom: 1,
        quickLinks: [],
        linkOpeningMode: "system",
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { openLink, hydrateLinkOpeningMode, getLinkOpeningMode } = await freshRouter();

    expect(getLinkOpeningMode()).toBe("in-app"); // the default before hydration
    await hydrateLinkOpeningMode();
    await hydrateLinkOpeningMode(); // the memo: still one GET
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(getLinkOpeningMode()).toBe("system");

    // The hydrated preference drives the very next link.
    const result = await openLink(URL_OK);
    expect(result).toMatchObject({ outcome: "system", reason: "preference" });
  });

  it("a failed hydration keeps the default (the preference never blocks a link)", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("sidecar down");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const { hydrateLinkOpeningMode, getLinkOpeningMode, openLink, useProjectChatStore, useRightSidebarStore } =
      await freshRouter();
    useProjectChatStore.setState({ activeProjectId: "prj_chat" });
    useRightSidebarStore.setState({ openBrowser: vi.fn(() => "tab_probe") });

    await hydrateLinkOpeningMode();
    expect(getLinkOpeningMode()).toBe("in-app");
    expect((await openLink(URL_OK)).outcome).toBe("in-app");
  });

  it("a bad wire value is never trusted — the cache keeps its current mode", async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse({
        searchEngine: "duckduckgo",
        homepage: "acute://home",
        defaultZoom: 1,
        quickLinks: [],
        linkOpeningMode: "mailto??",
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { hydrateLinkOpeningMode, getLinkOpeningMode } = await freshRouter();

    await hydrateLinkOpeningMode();
    expect(getLinkOpeningMode()).toBe("in-app"); // unchanged, not guessed
  });

  it("an in-flight hydration settles BEFORE the routing decision (an in-boot click obeys the saved preference)", async () => {
    let resolveFetch: ((r: Response) => void) | null = null;
    const fetchSpy = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    // The settled preference routes system → window.open (the spy pins the
    // web-mode leg actually fired, not just the result's claim).
    const openSpy = stubWindowOpen();
    const { openLink, hydrateLinkOpeningMode, useProjectChatStore, useRightSidebarStore } = await freshRouter();
    useProjectChatStore.setState({ activeProjectId: "prj_chat" });
    useRightSidebarStore.setState({ openBrowser: vi.fn(() => "tab_probe") });

    const hydration = hydrateLinkOpeningMode(); // kicked, not yet settled
    const pending = openLink(URL_OK); // clicked while in flight
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // TS flow-narrows resolveFetch to null here (the assignment lives in the
    // Promise executor's closure) — the cast re-widens it to the real union.
    const releaseFetch = resolveFetch as ((r: Response) => void) | null;
    releaseFetch?.(
      jsonResponse({
        searchEngine: "duckduckgo",
        homepage: "acute://home",
        defaultZoom: 1,
        quickLinks: [],
        linkOpeningMode: "system",
      }),
    );
    await hydration;
    const result = await pending;
    expect(result).toMatchObject({ outcome: "system", reason: "preference" });
    expect(openSpy).toHaveBeenCalledWith(URL_OK, "_blank", "noreferrer");
  });
});
