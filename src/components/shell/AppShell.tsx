import { Outlet, useLocation } from "react-router";
import { useSidecarHealth } from "../../hooks/use-sidecar-health";
import { useProjectChatStore } from "../../lib/project-chat-store";
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
  const appSidebarVisible = useProjectChatStore((s) => s.appSidebarVisible);
  // /project/:id/chat hides the app sidebar unless the user toggled it on
  // (the hamburger lives ON the sidebar itself per round-22 owner direction).
  const isChatRoute = /^\/project\/[^/]+\/chat\/?$/.test(pathname);
  const showSidebar = !isChatRoute || appSidebarVisible;
  // On chat routes when the sidebar is hidden, show a floating hamburger to bring it back.
  const showFloatingHamburger = isChatRoute && !appSidebarVisible;

  return (
    <div className="relative h-screen w-full overflow-hidden" style={{ backgroundColor: "var(--ac-bg)" }}>
      {/* ROUND-40: the notification SSE stream lives for the app's lifetime
          — boots once on mount, auto-reconnects on close, no-op in demo
          mode. Mounted HERE so it survives every route change. */}
      <NotificationStreamStarter />
      {/* ROUND-40: the Toaster (bottom-right toast stack) — mounted ONCE at
          the app root so toasts surface regardless of which route is
          active, even when the sidebar (and thus the bell) is hidden on
          chat routes. */}
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
        {showFloatingHamburger && <FloatingSidebarToggle />}        {showSidebar && <Sidebar />}
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
 * ROUND-33: floating show-sidebar button — the APP LOGO (owner: "I would
 * like you to handle it properly and make it the logo of our application"),
 * pinned to the very top-left of the chat window when the sidebar is hidden.
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
