import { Outlet, useLocation } from "react-router";
import { useSidecarHealth } from "../../hooks/use-sidecar-health";
import { useProjectChatStore } from "../../lib/project-chat-store";
import { PushSetup } from "../../lib/push-setup";
import { isTauri } from "../../lib/sidecar";
import { AcuteLogo, Sidebar } from "./Sidebar";
import { NotificationStreamStarter } from "../notifications/NotificationStreamStarter";
import { Toaster } from "../notifications/Toaster";

/**
 * App shell (round-32 redesign per the owner-approved design
 * Acute-Ui-Screens.html Frame 1/5): themed full-bleed background with the
 * wizard's atmosphere (dot grid + three ambient glows), and BOTH the sidebar
 * and the chat window are FLOATING panels with 12px spacing on all sides
 * (owner: "the sidebar was a floating kind of one with proper spacing on all
 * 4 sides of it and the right side chat window was separate from it").
 *
 * Design language: docs/design/DESIGN-SYSTEM.md + the wizard's DNA (the
 * owner's approved aesthetic): solid accent fills for interactive elements,
 * 1.5px borders at the borderStrong tier, softShadow/bentoShadow on cards,
 * generous radii (14-24px), and extreme typographic contrast.
 */
export function AppShell() {
  const { pathname } = useLocation();
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

      {/* Dot grid — wizard pattern (28px, subtle) */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            "radial-gradient(circle at 1px 1px, var(--ac-dot-color) 1px, transparent 0)",
          backgroundSize: "28px 28px",
          opacity: 0.04,
        }}
      />

      {/* Ambient glows — wizard intensities (0.20, 0.08, 0.06) */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-32 -right-32 h-[420px] w-[420px] rounded-full opacity-[0.20] blur-[80px]"
        style={{ backgroundColor: "var(--ac-accent)" }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-40 -left-40 h-[520px] w-[520px] rounded-full opacity-[0.08] blur-[90px]"
        style={{ backgroundColor: "var(--ac-accent)" }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute top-1/3 right-1/4 h-[220px] w-[220px] rounded-full opacity-[0.06] blur-[70px]"
        style={{ backgroundColor: "var(--ac-accent-2, var(--ac-accent))" }}
      />

      <div className="relative z-10 flex h-full gap-3 p-3">
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
