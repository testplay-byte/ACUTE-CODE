import { Outlet, useLocation } from "react-router";
import { useProjectChatStore } from "../../lib/project-chat-store";
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
  // /project/:id/chat hides the app sidebar unless the user toggled it on.
  const isChatRoute = /^\/project\/[^/]+\/chat\/?$/.test(pathname);
  const showSidebar = !isChatRoute || appSidebarVisible;

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
        {showSidebar && <Sidebar />}
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
