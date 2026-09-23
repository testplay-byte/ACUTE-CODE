/**
 * ROUND-99 (R99-A, owner directive: "add native browser support… install the
 * browser packages and ship them alongside the application so it does not
 * have to rely on the device's browser itself") — the ONE sanctioned LINK
 * ROUTER. Every clickable http(s) link inside the app routes through
 * openLink() so the link goes where the USER's preference says — by default
 * the app's OWN embedded browser panel (the panel the WebView2 Fixed Version
 * engine now ships with the installer), never a silently-swallowed
 * `<a target="_blank">` (dead inside WebView2 — the documented AboutTab
 * lesson) and never an unsolicited jump to the device's default browser.
 *
 * THE CONTRACT (callers: ChatMarkdown links, FileViewerPanel markdown links,
 * AboutTab's Releases button — never call window.open/invoke yourself):
 *
 *   · SCHEME GATE — http/https ONLY, parsed through the WHATWG URL
 *     constructor. mailto:, file:, javascript:, ftp:, a scheme-relative ref
 *     or a malformed string is REFUSED with an honest result. Never guessed,
 *     never "probably fine".
 *   · PREFERENCE — the browser settings domain's linkOpeningMode
 *     ("in-app" | "system", default "in-app"; persisted via
 *     GET/PUT /settings/browser exactly like the other browser settings —
 *     agent-core storage/settings.ts `browser.linkOpeningMode`). The value
 *     lives in an in-memory cache here (the desktop-notifications pattern):
 *     hydrateLinkOpeningMode() seeds it once at app boot (best-effort — a
 *     failed GET keeps the default), setLinkOpeningMode() pushes every
 *     confirmed settings-card flip LIVE so the next click already obeys.
 *   · IN-APP PATH — resolves the CURRENT project (opts.projectId override →
 *     the project-chat store's activeProjectId → the right-sidebar store's
 *     activeProjectId) and lands the link as a browser tab in that project's
 *     sidebar via useRightSidebarStore.getState().openBrowser(projectId, url).
 *     No project context (global surfaces on a fresh boot) → the honest
 *     system-browser fallback, said so in the result. A store throw → the
 *     same fallback (a link must never become a dead click).
 *   · SYSTEM PATH — openExternalUrl() from native-browser.ts inside the
 *     Tauri shell (the Rust `open_external_url` OS-level handoff, http/https
 *     validated in Rust); window.open ONLY when window.__TAURI__ is absent
 *     (web dev mode — the same fallback spelling as the pre-R99 call sites).
 *   · ESCAPE HATCHES — opts.forceExternal is the deliberate "device browser,
 *     please" affordance (R120-U: AboutTab's Releases button passes it
 *     ALWAYS — release links never open in-app; BrowserPanel's own
 *     Open-externally controls stay on their direct openExternalUrl paths
 *     — explicit user intent, no routing).
 *
 * Every leg returns a typed OpenLinkResult so callers and tests can assert
 * exactly where the link went (and why) — including the honest refusal and
 * the external-open failure, never a silent void.
 */
import { isTauri } from "./sidecar";
import { openExternalUrl } from "./native-browser";
import { useRightSidebarStore } from "./right-sidebar-store";
import { useProjectChatStore } from "./project-chat-store";
import { fetchBrowserSettings, type LinkOpeningMode } from "./api";

export type { LinkOpeningMode };

export interface OpenLinkOptions {
  /** The project whose sidebar should host the in-app browser tab. When
   * omitted (or null) the router resolves the ACTIVE project from the
   * stores — the same resolution the chat route maintains. */
  projectId?: string | null;
  /** The deliberate escape hatch: open in the DEVICE's browser, ignoring
   * the in-app preference. Reserved for explicit user intent. */
  forceExternal?: boolean;
}

/** Where a link went, and why — the full decision matrix is enumerable from
 * these variants (see the module docblock for the legs). */
export type OpenLinkResult =
  | { outcome: "in-app"; url: string; projectId: string; tabId: string }
  | {
      outcome: "system";
      url: string;
      reason: "preference" | "force-external" | "no-project" | "store-error";
      via: "tauri" | "window-open";
    }
  | { outcome: "refused"; url: string; reason: "scheme" | "invalid-url" }
  | { outcome: "error"; url: string; reason: "external-open-failed"; message: string };

/** The preference cache (default "in-app" — the owner's directive: the app
 * ships its own browser, links open inside it). */
let linkOpeningMode: LinkOpeningMode = "in-app";

/** The boot hydration's memo — null until hydrateLinkOpeningMode() is first
 * called. openLink() awaits it ONLY when already in flight (an in-boot click
 * pays the local sidecar's few ms, never a cold start). */
let hydration: Promise<void> | null = null;

/** The LIVE settings push (the Browser settings card calls this on every
 * confirmed flip + every fresh GET — the setDesktopNotificationsEnabled
 * pattern: the next click already obeys, no restart). */
export function setLinkOpeningMode(mode: LinkOpeningMode): void {
  linkOpeningMode = mode;
}

/** Read-side of the cache (tests + diagnostics). */
export function getLinkOpeningMode(): LinkOpeningMode {
  return linkOpeningMode;
}

/** App-boot hydration (AppShell calls this once, beside
 * initDesktopNotifications): one best-effort GET /settings/browser; the
 * saved linkOpeningMode seeds the cache. A failure keeps the default —
 * the preference must never block a link. Memoized: the second call returns
 * the same settled promise. */
export function hydrateLinkOpeningMode(): Promise<void> {
  if (hydration === null) {
    hydration = fetchBrowserSettings()
      .then((settings) => {
        // The sidecar validates the field, but never trust the wire: only a
        // value of the two sanctioned spellings lands; anything else keeps
        // the current cache (not a reason to guess).
        if (settings.linkOpeningMode === "in-app" || settings.linkOpeningMode === "system") {
          linkOpeningMode = settings.linkOpeningMode;
        }
      })
      .catch(() => undefined);
  }
  return hydration;
}

/** The system leg: the Rust handoff inside the shell, window.open outside
 * it (web dev mode — where window.open actually works). */
async function openSystem(
  url: string,
  reason: "preference" | "force-external" | "no-project" | "store-error",
): Promise<OpenLinkResult> {
  if (!isTauri()) {
    window.open(url, "_blank", "noreferrer");
    return { outcome: "system", url, reason, via: "window-open" };
  }
  try {
    await openExternalUrl(url);
    return { outcome: "system", url, reason, via: "tauri" };
  } catch (err) {
    // The OS-level handoff refused (the Rust command validates http/https
    // again and can reject) — reported honestly, never swallowed.
    return {
      outcome: "error",
      url,
      reason: "external-open-failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Resolves the project whose sidebar hosts the in-app browser tab: the
 * caller's explicit override, else the chat route's active project, else
 * the right-sidebar's (ChatFocusLayout maintains both). Null = no context. */
function resolveProjectId(opts?: OpenLinkOptions): string | null {
  const override = opts?.projectId;
  if (typeof override === "string" && override !== "") return override;
  const chatActive = useProjectChatStore.getState().activeProjectId;
  if (typeof chatActive === "string" && chatActive !== "") return chatActive;
  const sidebarActive = useRightSidebarStore.getState().activeProjectId;
  if (typeof sidebarActive === "string" && sidebarActive !== "") return sidebarActive;
  return null;
}

/** THE link router — the module docblock's contract, verbatim order:
 * scheme gate → force-external → (in-flight hydration) → preference →
 * project resolution → the in-app browser tab, with the honest system /
 * refusal / error results along the way. */
export async function openLink(url: string, opts?: OpenLinkOptions): Promise<OpenLinkResult> {
  // 1. The scheme gate — http/https ONLY, parsed, never guessed.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { outcome: "refused", url, reason: "invalid-url" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { outcome: "refused", url, reason: "scheme" };
  }

  // 2. The deliberate escape hatch beats every preference.
  if (opts?.forceExternal === true) {
    return openSystem(url, "force-external");
  }

  // 3. An in-flight boot hydration settles first (an already-settled memo
  //    resolves instantly; a never-started one never blocks the click).
  if (hydration !== null) await hydration;

  // 4. The preference: "system" is the user's explicit standing order.
  if (linkOpeningMode === "system") {
    return openSystem(url, "preference");
  }

  // 5. The in-app path needs a project to open the sidebar tab IN.
  const projectId = resolveProjectId(opts);
  if (projectId === null) {
    return openSystem(url, "no-project");
  }

  try {
    const tabId = useRightSidebarStore.getState().openBrowser(projectId, url);
    return { outcome: "in-app", url, projectId, tabId };
  } catch (err) {
    // The store refused (a corrupt persisted slice can throw inside zustand
    // set) — the link still opens, in the system browser, said so honestly.
    console.warn("[open-link] the browser-tab store threw — falling back to the system browser:", err);
    return openSystem(url, "store-error");
  }
}
