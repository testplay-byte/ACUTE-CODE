import { create } from "zustand";
import { useConfigStore } from "./config-store";

/**
 * ROUND-43 (R43-10) — the EMBEDDED BROWSER panel state.
 *
 * The right-sidebar BrowserPanel is a REAL in-app browser: pages render inside
 * a sandboxed iframe through the sidecar's /api/v1/browser/* proxy routes
 * (agent-core/src/browser-proxy.ts — framing headers stripped, URLs
 * re-proxied, history + viewport kept per tab session server-side). This
 * store owns the per-tab UI state: the proxy ticket (iframes cannot send
 * Authorization headers, so proxy URLs carry `&bt=<ticket>`), the current
 * URL/title, back/forward flags, the display-size (viewport) state mirrored
 * from the server (optimistic on edit), and the panel-only "fit" preference.
 *
 * Server-side state is the source of truth (the browser_control agent tool
 * reads/writes the SAME sessions) — the panel polls /browser/history +
 * /browser/viewport every few seconds and follows agent-made navigations and
 * viewport changes live. navSeq bumps whenever the iframe must (re)load; the
 * panel reacts to it by rebuilding the iframe src.
 */

// ── types (mirror of the backend route contracts) ──────────────────────────

export interface BrowserViewportState {
  width: number;
  height: number;
  preset: string;
  zoom: number;
  rotate: boolean;
}

export interface BrowserHistoryEntry {
  url: string;
  title: string | null;
  ts: number;
}

export interface BrowserHistoryView {
  sessionId: string;
  entries: BrowserHistoryEntry[];
  index: number;
  canBack: boolean;
  canForward: boolean;
}

/** Display-size presets — mirror of VIEWPORT_PRESETS (browser-proxy.ts). */
export const BROWSER_VIEWPORT_PRESETS: ReadonlyArray<{ id: string; width: number; height: number; label: string }> = [
  { id: "mobile-sm", width: 375, height: 667, label: "375×667 · mobile-sm" },
  { id: "mobile-md", width: 390, height: 844, label: "390×844 · mobile-md" },
  { id: "tablet", width: 768, height: 1024, label: "768×1024 · tablet" },
  { id: "laptop", width: 1280, height: 800, label: "1280×800 · laptop" },
  { id: "desktop", width: 1440, height: 900, label: "1440×900 · desktop" },
  { id: "full-hd", width: 1920, height: 1080, label: "1920×1080 · full-hd" },
];

export const BROWSER_VIEWPORT_DEFAULT: BrowserViewportState = {
  width: 1280,
  height: 800,
  preset: "laptop",
  zoom: 1,
  rotate: false,
};

export type BrowserTabStatus = "idle" | "ready" | "error";

export interface BrowserTabUiState {
  status: BrowserTabStatus;
  /** Sanitized tab id used as the server-side session id. */
  sessionId: string;
  /** Proxy ticket (`bt`) — minted via POST /browser/session. */
  ticket: string | null;
  ticketExpiresAt: number | null;
  currentUrl: string | null;
  currentTitle: string | null;
  index: number;
  canBack: boolean;
  canForward: boolean;
  viewport: BrowserViewportState;
  /** Panel-only: scale the viewport frame down to fit the panel width. */
  fit: boolean;
  loading: boolean;
  error: string | null;
  /** Increments on every intent to (re)load the iframe. */
  navSeq: number;
}

// ── sessionId hygiene ──────────────────────────────────────────────────────

/**
 * The backend validates sessionIds against ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$
 * (it is embedded into rewritten proxy URLs). Right-sidebar tab ids
 * ("tab-<base36>-<base36>") already fit; this hardens against any future id
 * scheme (strip invalid chars, fix the leading char, cap length).
 */
export function toBrowserSessionId(tabId: string): string {
  const cleaned = tabId.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64);
  if (cleaned === "") return `tab-${Date.now().toString(36)}`;
  if (/^[A-Za-z0-9]/.test(cleaned)) return cleaned;
  return `t${cleaned}`.slice(0, 64);
}

// ── HTTP helpers (same reachability contract as src/lib/api.ts) ────────────

export class BrowserApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "BrowserApiError";
  }
}

async function browserRequest<T>(path: string, init?: { method?: string; json?: unknown }): Promise<T> {
  const { baseUrl, token } = useConfigStore.getState();
  const headers: Record<string, string> = {};
  if (init?.json !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/v1${path}`, {
      method: init?.method ?? (init?.json !== undefined ? "POST" : "GET"),
      headers,
      ...(init?.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
    });
  } catch (cause) {
    throw new BrowserApiError(0, `Could not reach agent-core at ${baseUrl} (${String(cause)})`);
  }
  if (!res.ok) {
    let message = `sidecar answered HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body?.error?.message) message = body.error.message;
    } catch {
      /* non-JSON error body — keep the status line */
    }
    throw new BrowserApiError(res.status, message);
  }
  return (await res.json()) as T;
}

// ── route clients ──────────────────────────────────────────────────────────

export interface MintSessionResponse {
  sessionId: string;
  ticket: string;
  expiresAt: number;
  history: BrowserHistoryView;
  viewport: BrowserViewportState;
}

export interface NavigateResponse {
  sessionId: string;
  action: string;
  entry: BrowserHistoryEntry | null;
  index: number;
  canBack: boolean;
  canForward: boolean;
}

export interface ViewportResponse {
  sessionId: string;
  viewport: BrowserViewportState;
}

/** POST /browser/session — mint (or rotate) this tab's proxy ticket. */
export function mintBrowserSession(sessionId: string): Promise<MintSessionResponse> {
  return browserRequest<MintSessionResponse>("/browser/session", { json: { sessionId } });
}

/** POST /browser/navigate — record a navigation or walk back/forward/reload. */
export function browserNavigate(sessionId: string, body: { url?: string; title?: string; direction?: "back" | "forward" | "reload" }): Promise<NavigateResponse> {
  return browserRequest<NavigateResponse>("/browser/navigate", { json: { sessionId, ...body } });
}

/** GET /browser/history — back/forward state (also LRU-touches the session). */
export function fetchBrowserHistory(sessionId: string): Promise<BrowserHistoryView> {
  return browserRequest<BrowserHistoryView>(`/browser/history?sessionId=${encodeURIComponent(sessionId)}`);
}

/** GET /browser/viewport — display-size state (agent tool writes land here). */
export function fetchBrowserViewport(sessionId: string): Promise<ViewportResponse> {
  return browserRequest<ViewportResponse>(`/browser/viewport?sessionId=${encodeURIComponent(sessionId)}`);
}

/** PUT /browser/viewport — persist display-size changes server-side. */
export function putBrowserViewport(sessionId: string, patch: Partial<Pick<BrowserViewportState, "width" | "height" | "preset" | "zoom" | "rotate">>): Promise<ViewportResponse> {
  return browserRequest<ViewportResponse>(`/browser/viewport?sessionId=${encodeURIComponent(sessionId)}`, {
    method: "PUT",
    json: patch,
  });
}

/** The iframe src: everything the header-less iframe navigation needs. */
export function buildProxySrc(url: string, sessionId: string, ticket: string): string {
  const { baseUrl } = useConfigStore.getState();
  const query = new URLSearchParams({ url, sessionId, bt: ticket });
  return `${baseUrl}/api/v1/browser/proxy?${query.toString()}`;
}

/**
 * Cheap ticket liveness probe: a proxy fetch WITHOUT the Authorization header
 * and with an unparseable ?url= — a DEAD ticket gets the hook's HTML 401
 * before any handler runs; a VALID ticket is promoted to bearer and the
 * handler answers the harmless 400 "not a valid absolute URL" page. No
 * upstream is ever contacted either way.
 */
export async function probeBrowserTicket(url: string, sessionId: string, ticket: string): Promise<boolean> {
  const { baseUrl } = useConfigStore.getState();
  const query = new URLSearchParams({ url, sessionId, bt: ticket });
  try {
    const res = await fetch(`${baseUrl}/api/v1/browser/proxy?${query.toString()}`);
    return res.status !== 401;
  } catch {
    return false;
  }
}

// ── the store ──────────────────────────────────────────────────────────────

interface BrowserTabStoreState {
  tabs: Record<string, BrowserTabUiState>;
  /** Initialize the per-tab slice (idempotent — returns the existing one). */
  ensureTab: (tabId: string) => BrowserTabUiState;
  getTab: (tabId: string) => BrowserTabUiState | undefined;
  /** Mint (or re-mint) the ticket; adopts server history + viewport. */
  mint: (tabId: string) => Promise<void>;
  /** Address-bar / quick-link / acute:open navigation. */
  navigate: (tabId: string, rawUrl: string) => Promise<void>;
  /** Back / forward / reload. */
  go: (tabId: string, direction: "back" | "forward" | "reload") => Promise<void>;
  /** Optimistic viewport change + server PUT. */
  setViewport: (
    tabId: string,
    patch: Partial<Pick<BrowserViewportState, "width" | "height" | "preset" | "zoom" | "rotate">>,
  ) => Promise<void>;
  /** Toggle the panel-only fit preference. */
  setFit: (tabId: string, fit: boolean) => void;
  /** Poll merge (history + viewport); follows agent-driven changes. */
  refresh: (tabId: string) => Promise<void>;
  /** The escape hatch's acute:location (final URL after redirects). */
  handleLocationMessage: (tabId: string, url: string) => Promise<void>;
  /** The escape hatch's acute:title — stores it as a title-update. */
  handleTitleMessage: (tabId: string, title: string) => Promise<void>;
  /** A page-initiated window.open — the PANEL decides (in-panel by default). */
  handleOpenMessage: (tabId: string, url: string) => Promise<void>;
  setLoading: (tabId: string, loading: boolean) => void;
  /** Surface a panel-level error (retry card) without a failed request. */
  setError: (tabId: string, error: string | null) => void;
  clearError: (tabId: string) => void;
  /** Test-only: drop all tab state. */
  resetAll: () => void;
}

function freshTab(sessionId: string): BrowserTabUiState {
  return {
    status: "idle",
    sessionId,
    ticket: null,
    ticketExpiresAt: null,
    currentUrl: null,
    currentTitle: null,
    index: -1,
    canBack: false,
    canForward: false,
    viewport: { ...BROWSER_VIEWPORT_DEFAULT },
    fit: true,
    loading: false,
    error: null,
    navSeq: 0,
  };
}

function patchTabState(
  state: BrowserTabStoreState,
  tabId: string,
  patch: Partial<BrowserTabUiState>,
): { tabs: Record<string, BrowserTabUiState> } {
  const cur = state.tabs[tabId];
  if (cur === undefined) return { tabs: state.tabs };
  return { tabs: { ...state.tabs, [tabId]: { ...cur, ...patch } } };
}

export const useBrowserTabStore = create<BrowserTabStoreState>()((set, get) => ({
  tabs: {},
  ensureTab: (tabId) => {
    const existing = get().tabs[tabId];
    if (existing !== undefined) return existing;
    const fresh = freshTab(toBrowserSessionId(tabId));
    set((s) => ({ tabs: { ...s.tabs, [tabId]: fresh } }));
    return fresh;
  },
  getTab: (tabId) => get().tabs[tabId],
  mint: async (tabId) => {
    const tab = get().tabs[tabId] ?? get().ensureTab(tabId);
    try {
      const minted = await mintBrowserSession(tab.sessionId);
      set((s) =>
        patchTabState(s, tabId, {
          status: "ready",
          ticket: minted.ticket,
          ticketExpiresAt: minted.expiresAt,
          error: null,
          viewport: minted.viewport,
          index: minted.history.index,
          canBack: minted.history.canBack,
          canForward: minted.history.canForward,
          currentUrl:
            minted.history.index >= 0 ? (minted.history.entries[minted.history.index]?.url ?? null) : null,
          currentTitle:
            minted.history.index >= 0 ? (minted.history.entries[minted.history.index]?.title ?? null) : null,
        }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set((s) => patchTabState(s, tabId, { status: "error", error: `Could not open a browser session: ${message}` }));
    }
  },
  navigate: async (tabId, rawUrl) => {
    const tab = get().tabs[tabId] ?? get().ensureTab(tabId);
    set((s) => patchTabState(s, tabId, { loading: true, error: null }));
    try {
      const res = await browserNavigate(tab.sessionId, { url: rawUrl });
      set((s) => {
        const cur = s.tabs[tabId];
        if (cur === undefined) return s;
        return patchTabState(s, tabId, {
          currentUrl: res.entry?.url ?? rawUrl,
          currentTitle: res.entry?.title ?? null,
          index: res.index,
          canBack: res.canBack,
          canForward: res.canForward,
          loading: true,
          navSeq: cur.navSeq + 1,
        });
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set((s) => patchTabState(s, tabId, { loading: false, error: `Navigation failed: ${message}` }));
    }
  },
  go: async (tabId, direction) => {
    const tab = get().tabs[tabId] ?? get().ensureTab(tabId);
    try {
      const res = await browserNavigate(tab.sessionId, { direction });
      if (res.action === "noop" || res.entry === null) {
        // Boundary — adopt the flags but do not reload anything.
        set((s) => patchTabState(s, tabId, { canBack: res.canBack, canForward: res.canForward, index: res.index }));
        return;
      }
      set((s) => {
        const cur = s.tabs[tabId];
        if (cur === undefined) return s;
        return patchTabState(s, tabId, {
          currentUrl: res.entry?.url ?? cur.currentUrl,
          currentTitle: res.entry?.title ?? null,
          index: res.index,
          canBack: res.canBack,
          canForward: res.canForward,
          loading: true,
          navSeq: cur.navSeq + 1,
        });
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set((s) => patchTabState(s, tabId, { loading: false, error: `Navigation failed: ${message}` }));
    }
  },
  setViewport: async (tabId, patch) => {
    const tab = get().tabs[tabId] ?? get().ensureTab(tabId);
    // Optimistic: the panel feels instant; the PUT is the persisted truth
    // (and what the agent tool + a later poll reconcile against).
    const optimistic: BrowserViewportState = { ...tab.viewport, ...patch };
    if (patch.preset !== undefined && patch.preset !== "custom") {
      const preset = BROWSER_VIEWPORT_PRESETS.find((p) => p.id === patch.preset);
      if (preset) {
        optimistic.width = preset.width;
        optimistic.height = preset.height;
      }
    }
    if (patch.preset === undefined && (patch.width !== undefined || patch.height !== undefined)) {
      optimistic.preset = "custom";
    }
    set((s) => patchTabState(s, tabId, { viewport: optimistic }));
    try {
      const res = await putBrowserViewport(tab.sessionId, patch);
      set((s) => patchTabState(s, tabId, { viewport: res.viewport }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set((s) => patchTabState(s, tabId, { error: `Viewport change failed: ${message}` }));
    }
  },
  setFit: (tabId, fit) => set((s) => patchTabState(s, tabId, { fit })),
  refresh: async (tabId) => {
    const tab = get().tabs[tabId];
    if (tab === undefined || tab.ticket === null) return;
    try {
      const [history, viewportRes] = await Promise.all([
        fetchBrowserHistory(tab.sessionId),
        fetchBrowserViewport(tab.sessionId),
      ]);
      const serverUrl = history.index >= 0 ? (history.entries[history.index]?.url ?? null) : null;
      const serverTitle = history.index >= 0 ? (history.entries[history.index]?.title ?? null) : null;
      const cur = get().tabs[tabId];
      if (cur === undefined) return;
      // Session-loss recovery (sidecar restarted): the server forgot the tab
      // but the panel still shows a page → re-mint + rebuild the iframe.
      if (serverUrl === null && cur.currentUrl !== null) {
        await get().mint(tabId);
        const renewed = get().tabs[tabId];
        if (renewed === undefined) return;
        await browserNavigate(renewed.sessionId, { url: cur.currentUrl, title: cur.currentTitle ?? undefined });
        set((s) => {
          const c = s.tabs[tabId];
          if (c === undefined) return s;
          return patchTabState(s, tabId, { loading: true, navSeq: c.navSeq + 1 });
        });
        return;
      }
      const followAgent = serverUrl !== null && serverUrl !== cur.currentUrl;
      set((s) => {
        const c = s.tabs[tabId];
        if (c === undefined) return s;
        return patchTabState(s, tabId, {
          index: history.index,
          canBack: history.canBack,
          canForward: history.canForward,
          // An agent-initiated navigation (browser_control) — follow it live.
          ...(followAgent
            ? {
                currentUrl: serverUrl,
                currentTitle: serverTitle,
                loading: true,
                navSeq: c.navSeq + 1,
              }
            : { currentTitle: serverTitle ?? c.currentTitle }),
          viewport: viewportRes.viewport,
        });
      });
    } catch {
      // Polling is best-effort — transient sidecar hiccups surface via the
      // next successful poll or the mint error path, never as UI noise.
    }
  },
  handleLocationMessage: async (tabId, url) => {
    const tab = get().tabs[tabId];
    if (tab === undefined || tab.currentUrl === url) {
      // Same URL → at most refresh the flags (redirect landed where we
      // expected); no history noise.
      if (tab !== undefined) set((s) => patchTabState(s, tabId, { loading: false }));
      return;
    }
    try {
      const res = await browserNavigate(tab.sessionId, { url });
      // Keep an already-arrived title (location + title messages can race —
      // the title often lands while this POST is still in flight).
      const knownTitle = get().tabs[tabId]?.currentTitle ?? null;
      const entryTitle = res.entry?.title ?? null;
      set((s) =>
        patchTabState(s, tabId, {
          currentUrl: url,
          currentTitle: entryTitle ?? knownTitle,
          index: res.index,
          canBack: res.canBack,
          canForward: res.canForward,
          loading: false,
        }),
      );
    } catch {
      set((s) => patchTabState(s, tabId, { loading: false }));
    }
  },
  handleTitleMessage: async (tabId, title) => {
    const tab = get().tabs[tabId];
    if (tab === undefined || tab.currentUrl === null || title === "") return;
    set((s) => patchTabState(s, tabId, { currentTitle: title }));
    try {
      // Same-URL navigate = title-update on the server (no new entry).
      await browserNavigate(tab.sessionId, { url: tab.currentUrl, title });
    } catch {
      /* best-effort — the title is cosmetic */
    }
  },
  handleOpenMessage: (tabId, url) => get().navigate(tabId, url),
  setLoading: (tabId, loading) => set((s) => patchTabState(s, tabId, { loading })),
  setError: (tabId, error) => set((s) => patchTabState(s, tabId, { error })),
  clearError: (tabId) => set((s) => patchTabState(s, tabId, { error: null })),
  resetAll: () => set({ tabs: {} }),
}));
