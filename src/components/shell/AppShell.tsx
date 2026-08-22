import { Outlet } from "react-router";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";

/**
 * Bento layout from the dashboard demo: padded app background, sidebar card,
 * main card with its own topbar. The dot-grid + ambient accent glows are part
 * of the owner's design language.
 */
export function AppShell() {
  return (
    <div className="relative h-screen w-full overflow-hidden">
      {/* Subtle dot grid + accent ambient glows (demo DashboardPage pattern). */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.025]"
        style={{
          backgroundImage: "radial-gradient(circle at 1px 1px, var(--text) 1px, transparent 0)",
          backgroundSize: "24px 24px",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -top-32 -right-32 h-[350px] w-[350px] rounded-full opacity-[0.05] blur-[100px]"
        style={{ backgroundColor: "var(--accent)" }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-40 -left-40 h-[400px] w-[400px] rounded-full opacity-[0.03] blur-[120px]"
        style={{ backgroundColor: "var(--accent)" }}
      />

      <div className="relative z-10 flex h-full flex-col">
        <TopBar />
        <div className="flex min-h-0 flex-1 gap-3 p-3 md:p-4">
          <Sidebar />
          <main className="min-w-0 flex-1 overflow-y-auto rounded-xl border-[1.5px] border-line bg-card">
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  );
}
