import { NavLink } from "react-router";
import {
  BarChart3,
  Bot,
  FolderGit2,
  LayoutDashboard,
  MessagesSquare,
  Settings,
} from "lucide-react";
import { motion } from "framer-motion";
import { APP_NAME } from "../../lib/version";
import { cn } from "../../lib/utils";
import { slideInLeft } from "../../lib/motion";

/** The six SPEC F9 screens. Only Agents is real in Wave 1; the rest are placeholders. */
const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/project", label: "Project", icon: FolderGit2 },
  { to: "/agents", label: "Agents", icon: Bot },
  { to: "/sessions", label: "Sessions", icon: MessagesSquare },
  { to: "/usage", label: "Usage", icon: BarChart3 },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function Sidebar() {
  return (
    <motion.aside
      variants={slideInLeft}
      initial="initial"
      animate="animate"
      className="hidden w-[220px] shrink-0 flex-col rounded-xl border-[1.5px] border-line bg-card md:flex"
    >
      <div className="flex items-center gap-2.5 px-4 pt-4 pb-3">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-[13px] font-bold text-white">
          A
        </div>
        <div className="min-w-0">
          <div className="truncate text-[13px] font-bold tracking-tight">{APP_NAME}</div>
          <div className="text-[10px] text-muted">multi-agent workbench</div>
        </div>
      </div>
      <div className="mx-3 border-t-[1.5px] border-line" />
      <nav className="flex flex-1 flex-col gap-0.5 p-2">
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-2.5 rounded-lg border-[1.5px] px-2.5 py-2 text-[12px] font-semibold transition-colors duration-200",
                isActive
                  ? "border-accent-faded bg-accent-soft text-accent"
                  : "border-transparent text-muted hover:bg-hover hover:text-ink",
              )
            }
          >
            <Icon size={15} strokeWidth={2.25} />
            {label}
          </NavLink>
        ))}
      </nav>
      <div className="border-t-[1.5px] border-line p-3 text-[10px] text-muted">
        local-first · no telemetry
      </div>
    </motion.aside>
  );
}
