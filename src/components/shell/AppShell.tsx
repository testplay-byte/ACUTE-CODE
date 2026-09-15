import { useEffect } from "react";
import { Outlet, useLocation } from "react-router";
import { useSidecarHealth } from "../../hooks/use-sidecar-health";
import { useProjectChatStore } from "../../lib/project-chat-store";
import { PushSetup } from "../../lib/push-setup";
import { isTauri } from "../../lib/sidecar";
// R98-J (owner: task complete / failed / permission needed → the user's
// PC): the tauri-plugin-notification bridge's app-start init — a
// best-effort permission pre-check (Tauri only; web mode is a no-op
// inside the bridge itself).
import { initDesktopNotifications } from "../../lib/desktop-notifications";
// R99-A (owner: "ship the browser with the app"): the central link
// router's preference hydration — seeds the in-memory linkOpeningMode cache
// from GET /settings/browser once at boot so the FIRST link click already
// obeys the saved preference (best-effort; a failed GET keeps the default
// in-app mode).
import { hydrateLinkOpeningMode } from "../../lib/open-link";
import { AcuteLogo, Sidebar } from "./Sidebar";
import { NotificationStreamStarter } from "../notifications/NotificationStreamStarter";
import { Toaster } from "../notifications/Toaster";
// R60-D: the shared webview-suppression guard (R62: also the general
// overlay watcher — installed once here so it covers every route).
import { installOverlayWebviewWatcher } from "../right-sidebar/popover-webview-guard";
// ROUND-61 (R61): the floating computer-use monitor — the owner's
// directive: "in a mini window it will show the details and their stats
// while the agent is using computers". Mounted ONCE here — app-global,
// independent of the route. ROUND-64 (R64-b): it is now a CONTROLLER — it
// AUTO-opens the always-on-top OS monitor window (Tauri) / shows the minimal
// top-center pill (web) the moment live computer-use activity starts, and
// auto-dismisses it when the session ends. The right-sidebar computer tab
// is gone (the floating monitor is the only surface).
import { ComputerMiniWindow } from "../ComputerMiniWindow";

/**
 * App shell (round-32 redesign per the owner-approved design
 * Acute-Ui-Screens.html Frame 1/5). ROUND-62 (owner: "remove that container
 * so there is more space — by container i mean the background with the
 * gradient colours on it; don't remove the padding on the sides and the
 * rounded corners on the whole view"): the wizard's atmosphere layers (dot
 * grid + the three ambient accent glows) are GONE — the shell background is
 * now the flat theme background, which reads as more room for the three
 * panels. The SIDE PADDING stays (p-2 — one notch tighter than the old p-3,
 * still visible on every side) and every panel keeps its own rounded
 * corners; in Tauri mode the App root's inset frame + rounded content card
 * are untouched (that is "the rounded corners on the whole view").
 *
 * Design language: docs/design/DESIGN-SYSTEM.md + the wizard's DNA (the
 * owner's approved aesthetic): solid accent fills for interactive elements,
 * 1.5px borders at the borderStrong tier, softShadow/bentoShadow on cards,
 * generous radii (14-24px), and extreme typographic contrast.
 */
export function AppShell() {
  const { pathname } = useLocation();
  // R62-D9: install the DOM overlay watcher ONCE (app-global) — while any
  // menu/dialog/popover is open, every native browser webview hides itself
  // (OS-level webviews float above ALL app HTML; without this every overlay
  // that opens near the browser renders BEHIND it — the owner: "if a menu
  // opened up then it would show under the browser").
  useEffect(() => {
    installOverlayWebviewWatcher();
  }, []);
  // R98-J: the desktop-notification bridge boots with the app (the
  // best-effort permission pre-check — the real fires happen in the SSE
  // fan-out; see lib/desktop-notifications.ts). R99-A: the link router's
  // preference hydrates on the same beat.
  useEffect(() => {
    initDesktopNotifications();
    void hydrateLinkOpeningMode();
  }, []);
  // Round-28 WS-D2: boot-time health ping. If the sidecar is up + token is
  // set, flip demoData false so the streaming SSE path activates (the real
  // fix for the owner's "completes all tasks then shows the results"
  // complaint — root cause was demo mode falling back to the sync route).
  useSidecarHealth();
  // R60-C (owner): appSidebarVisible is GLOBAL — one control on EVERY route.
  // The old chat-route special-casing (!isChatRoute || visible) is gone: the
  // sidebar shows everywhere unless the owner hides it, and the ONE toggle is
  // the TITLE BAR's identity control (Tauri) or the floating logo (web dev).
  const appSidebarVisible = useProjectChatStore((s) => s.appSidebarVisible);
  const showSidebar = appSidebarVisible;
  // Web-mode fallback ONLY: browser dev has no custom title bar to click, so
  // the floating Acute logo is the show-sidebar affordance there. In Tauri
  // the title-bar identity control covers it — no floating chrome.
  const showFloatingHamburger = !isTauri() && !appSidebarVisible;
  const isChatRoute = /^\/project\/[^/]+\/chat\/?$/.test(pathname);

  return (
    // R58: h-full (was h-screen) — the App root now supplies the h-screen
    // flex column with the custom TitleBar on top (Tauri only; null in web,
    // where the single flex-1 child is the whole viewport, so this is
    // visually identical). All visuals below are untouched.
    <div className="relative h-full w-full overflow-hidden" style={{ backgroundColor: "var(--ac-bg)" }}>
      {/* ROUND-40: the notification SSE stream lives for the app's lifetime
          — boots once on mount, auto-reconnects on close, no-op in demo
          mode. Mounted HERE so it survives every route change. */}
      <NotificationStreamStarter />
      {/* ROUND-42: Web Push setup — registers /sw.js + subscribes the browser
          so desktop notifications fire even when the app window is CLOSED
          (the service worker receives the push; click opens the session). */}
      <PushSetup />
      {/* ROUND-40: the Toaster (bottom-right toast stack) — mounted ONCE at
          the app root so toasts surface regardless of which route is
          active, even when the sidebar (and thus the bell) is hidden. */}
      <Toaster />
      {/* ROUND-61 (R61) / ROUND-64 (R64-b): the floating computer-use
          monitor — auto-opened OS window (Tauri) / minimal top pill (web)
          with the STOP kill switch while the agent drives the desktop. */}
      <ComputerMiniWindow />

      {/* ROUND-62: the gradient atmosphere layers (dot grid + ambient glows)
          are DELETED per the owner's directive — flat theme background. The
          relative z-10 wrapper stays so floating chrome (mini window, toasts,
          floating logo) always paints above the panels. */}
      <div className="relative z-10 flex h-full gap-2 p-2">
        {showFloatingHamburger && <FloatingSidebarToggle />}
        {/* R60-C: showSidebar === appSidebarVisible on EVERY route — the
            sidebar is either fully here (270px floating panel) or fully
            absent (main takes the full width). */}
        {showSidebar && <Sidebar />}
        {/* Round-32: every route keeps the floating-panel language — the chat
            route renders its own rounded/bordered/soft-shadowed panel inside. */}
        <main
          className={
            isChatRoute
              ? "min-w-0 flex-1 overflow-hidden"
              : "min-w-0 flex-1 overflow-y-auto"
          }
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}

/**
 * ROUND-33 · R60-C: floating show-sidebar button — the APP LOGO (owner: "I
 * would like you to handle it properly and make it the logo of our
 * application"), pinned to the very top-left when the sidebar is hidden.
 * WEB DEV MODE ONLY — the desktop app's title-bar identity control owns the
 * toggle in Tauri, so this never renders there (AppShell gates it on
 * !isTauri()); its top offset is therefore the plain web-mode inset.
 */
function FloatingSidebarToggle() {
  const setAppSidebarVisible = useProjectChatStore((s) => s.setAppSidebarVisible);
  return (
    <div className="fixed top-[18px] left-[18px] z-50">
      <AcuteLogo
        size={38}
        hoverToggle
        onClick={() => setAppSidebarVisible(true)}
        ariaLabel="Acute — show sidebar"
        title="Show sidebar"
      />
    </div>
  );
}
