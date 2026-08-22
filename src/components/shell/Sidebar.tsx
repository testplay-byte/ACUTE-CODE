import { useState } from "react";
import { NavLink } from "react-router";
import {
  BarChart3,
  Bot,
  ChevronsLeft,
  ChevronsRight,
  FolderGit2,
  LayoutDashboard,
  MessagesSquare,
  Settings,
} from "lucide-react";
import { motion } from "framer-motion";
import type { LucideIcon } from "lucide-react";
import { APP_NAME } from "../../lib/version";
import { cn } from "../../lib/utils";
import { slideInLeft } from "../../lib/motion";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { bdr, withAlpha } from "../dashboard/helpers";

/** The six SPEC F9 screens. Dashboard/Agents/Sessions/Settings are real. */
const NAV: { to: string; label: string; icon: LucideIcon; end?: boolean }[] = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/project", label: "Project", icon: FolderGit2 },
  { to: "/agents", label: "Agents", icon: Bot },
  { to: "/sessions", label: "Sessions", icon: MessagesSquare },
  { to: "/usage", label: "Usage", icon: BarChart3 },
  { to: "/settings", label: "Settings", icon: Settings },
];

const COLLAPSE_KEY = "acute-code.sidebar.collapsed";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Sidebar restyled to the dashboard demo's Sidebar fidelity (letter tile brand,
 * 1.5px borders, accent-wash active states) plus a collapse-to-icons mode the
 * plan calls for. Visual only — routes unchanged.
 */
export function Sidebar() {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const styles = useThemeStyles();

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? "0" : "1");
      } catch {
        /* private-mode localStorage failures just skip persistence */
      }
      return !c;
    });
  };

  return (
    <motion.aside
      variants={slideInLeft}
      initial="initial"
      animate="animate"
      className={cn(
        "hidden shrink-0 flex-col overflow-hidden rounded-lg border-[1.5px] transition-all duration-200 md:flex",
        collapsed ? "w-[60px]" : "w-[220px]",
      )}
      style={{ backgroundColor: styles.card, borderColor: styles.border }}
    >
      {/* Brand */}
      <div
        className={cn(
          "flex items-center gap-2.5 pb-3 pt-4",
          collapsed ? "justify-center px-2" : "px-4",
        )}
      >
        <div
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sm font-bold"
          style={{ backgroundColor: styles.accent, color: styles.accentText }}
          title={APP_NAME}
        >
          A
        </div>
        {!collapsed ? (
          <div className="min-w-0">
            <div className="truncate text-[13px] font-bold tracking-tight" style={{ color: styles.text }}>
              {APP_NAME}
            </div>
            <div className="truncate text-[10px]" style={{ color: styles.textSecondary }}>
              multi-agent workbench
            </div>
          </div>
        ) : null}
      </div>
      <div className="mx-3 shrink-0" style={{ borderTop: bdr("1.5px", styles.border) }} />

      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-2">
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            title={collapsed ? label : undefined}
            aria-label={collapsed ? label : undefined}
            className={({ isActive }) =>
              cn(
                "flex shrink-0 cursor-pointer items-center gap-2.5 rounded-lg border-[1.5px] px-2.5 py-2 text-[12px] font-semibold transition-colors duration-200",
                collapsed && "justify-center px-0",
                !isActive && "border-transparent text-muted hover:bg-hover hover:text-ink",
              )
            }
            style={({ isActive }) =>
              isActive
                ? {
                    backgroundColor: withAlpha(styles.accent, 0.1),
                    borderColor: withAlpha(styles.accent, 0.3),
                    color: styles.accent,
                  }
                : undefined
            }
          >
            <Icon size={15} strokeWidth={2.25} className="shrink-0" />
            {!collapsed ? <span className="truncate">{label}</span> : null}
          </NavLink>
        ))}
      </nav>

      {/* Footer: tagline + collapse toggle */}
      <div className="shrink-0 p-2" style={{ borderTop: bdr("1.5px", styles.border) }}>
        <button
          onClick={toggleCollapsed}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className={cn(
            "flex h-7 w-full cursor-pointer items-center gap-2 rounded-lg px-2 text-muted transition-colors duration-200 hover:bg-hover hover:text-ink",
            collapsed && "justify-center px-0",
          )}
        >
          {collapsed ? <ChevronsRight size={13} /> : <ChevronsLeft size={13} />}
          {!collapsed ? (
            <span className="truncate font-mono text-[10px]">local-first · no telemetry</span>
          ) : null}
        </button>
      </div>
    </motion.aside>
  );
}
