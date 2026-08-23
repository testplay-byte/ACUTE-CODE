import { Outlet, useLocation } from "react-router";
import { Menu } from "lucide-react";
import { useProjectChatStore } from "../../lib/project-chat-store";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { Sidebar } from "./Sidebar";

/**
 * App shell (round-21 UI overhaul): themed full-bleed background with the
 * wizard's atmosphere (dot grid + three ambient glows at wizard intensities),
 * floating sidebar card, transparent main area for non-chat routes (cards
 * float like the wizard's), and the round-16 borderless/tight chat route.
 *
 * Design language: docs/design/DESIGN-SYSTEM.md + the wizard's DNA (the
 * owner's approved aesthetic): solid accent fills for interactive elements,
 * 1.5px borders at the borderStrong tier, softShadow/bentoShadow on cards,
 * generous radii (14-24px), and extreme typographic contrast.
 */
export function AppShell() {
  const { pathname } = useLocation();
  const appSidebarVisible = useProjectChatStore((s) => s.appSidebarVisible);
  // /project/:id/chat hides the app sidebar unless the user toggled it on
  // (the hamburger lives ON the sidebar itself per round-22 owner direction).
  const isChatRoute = /^\/project\/[^/]+\/chat\/?$/.test(pathname);
  const showSidebar = !isChatRoute || appSidebarVisible;
  // On chat routes when the sidebar is hidden, show a floating hamburger to bring it back.
  const showFloatingHamburger = isChatRoute && !appSidebarVisible;

  return (
    <div className="relative h-screen w-full overflow-hidden" style={{ backgroundColor: "var(--ac-bg)" }}>
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

      <div
        className={`relative z-10 flex h-full ${isChatRoute ? "gap-[3px] p-[2px]" : "gap-3 p-3 md:p-4"}`}
      >
        {showFloatingHamburger && <FloatingSidebarToggle />}        {showSidebar && <Sidebar />}
        {/* Chat route = borderless tight; other routes = transparent (cards float) */}
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

/** Floating hamburger shown on chat routes when the sidebar is hidden. */
function FloatingSidebarToggle() {
  const styles = useThemeStyles();
  const setAppSidebarVisible = useProjectChatStore((s) => s.setAppSidebarVisible);
  return (
    <button
      onClick={() => setAppSidebarVisible(true)}
      aria-label="Show sidebar"
      title="Show sidebar"
      className="fixed top-3 left-2 z-50 w-9 h-9 rounded-[10px] grid place-items-center transition-colors"
      style={{
        background: styles.card,
        color: styles.textSecondary,
        border: `1.5px solid ${styles.border}`,
        boxShadow: styles.softShadow,
      }}
    >
      <Menu size={15} />
    </button>
  );
}
