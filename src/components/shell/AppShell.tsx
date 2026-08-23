import { Outlet, useLocation } from "react-router";
import { useProjectChatStore } from "../../lib/project-chat-store";
import { Sidebar } from "./Sidebar";

/**
 * Bento layout from the dashboard demo. Owner round-8: the top bar is GONE
 * (useless chrome) — theme/mode controls moved into Settings. What remains:
 * padded app background, sidebar card, main card, all with four-side padding.
 *
 * Owner round-15: the project-chat screen is FULLSCREEN — the app sidebar is
 * hidden there by default and the chat TopBar's hamburger toggles it back.
 */
export function AppShell() {
  const { pathname } = useLocation();
  const appSidebarVisible = useProjectChatStore((s) => s.appSidebarVisible);
  // /project/:id/chat hides the app sidebar unless the user toggled it on.
  const isChatRoute = /^\/project\/[^/]+\/chat\/?$/.test(pathname);
  const showSidebar = !isChatRoute || appSidebarVisible;

  return (
    <div className="relative h-screen w-full overflow-hidden">
      {/* Subtle dot grid + accent ambient glows (demo DashboardPage pattern). */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            "radial-gradient(circle at 1px 1px, var(--ac-dot-color) 1px, transparent 0)",
          backgroundSize: "24px 24px",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -top-32 -right-32 h-[350px] w-[350px] rounded-full opacity-[0.05] blur-[100px]"
        style={{ backgroundColor: "var(--ac-accent)" }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-40 -left-40 h-[400px] w-[400px] rounded-full opacity-[0.03] blur-[120px]"
        style={{ backgroundColor: "var(--ac-accent)" }}
      />

      <div
        className={`relative z-10 flex h-full ${isChatRoute ? "gap-[3px] p-[2px]" : "gap-3 p-3 md:p-4"}`}
      >
        {showSidebar && <Sidebar />}
        <main
          className={
            isChatRoute
              ? "min-w-0 flex-1 overflow-hidden"
              : "min-w-0 flex-1 overflow-y-auto rounded-lg border-[1.5px] border-line bg-card"
          }
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}
