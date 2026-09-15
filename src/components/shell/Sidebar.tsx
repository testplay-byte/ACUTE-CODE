import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import {
  ArrowLeft,
  BarChart3,
  Bot,
  CircleAlert,
  FolderOpen,
  Globe,
  Info,
  LayoutDashboard,
  LoaderCircle,
  MessageSquare,
  Monitor,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  PlugZap,
  Plus,
  ScanEye,
  Server,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Users,
  X,
} from "lucide-react";
// R98-E1: the Prompts settings section's FileText icon (id-synced with
// SettingsPage TABS — the R44 lesson).
import { FileText } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { ApiError, pickFolderViaBackend, type Project, type Session } from "../../lib/api";
import { cn } from "../../lib/utils";
import { SEMANTIC_COLORS } from "../../lib/semantics";
import { isTauri } from "../../lib/sidecar";
import { useConfigStore } from "../../lib/config-store";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { useProjects, useCreateProject, useDeleteProject } from "../../hooks/use-projects";
import { useCreateSession, useDeleteSession, useRenameSession, useSessions } from "../../hooks/use-sessions";
import { useAgents } from "../../hooks/use-agents";
import { useActiveStreams } from "../../lib/active-streams";
import { useProjectChatStore } from "../../lib/project-chat-store";
import { withAlpha } from "../dashboard/helpers";
import { SkeletonRows } from "../shared/Skeletons";
import { NotificationBell } from "../notifications/NotificationBell";

type TauriGlobal = {
  core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
};

async function tauriInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const tauri = (window as { __TAURI__?: TauriGlobal }).__TAURI__;
  if (!tauri) throw new Error("Tauri shell unavailable");
  return tauri.core.invoke(command, args) as Promise<T>;
}

const EXPANDED_KEY = "acute-code.sidebar.expandedProjects";

function readExpanded(): string[] {
  try { return JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? "[]") as string[]; } catch { return []; }
}

/** ROUND-42: shade a hex color ±percent — feeds the project tile gradient
 * (owner: "the project's actual images need to be a bit better"). */
function shadeHex(hex: string, percent: number): string {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
  if (m === null) return hex;
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const r = clamp(parseInt(m[1], 16) + 255 * percent);
  const g = clamp(parseInt(m[2], 16) + 255 * percent);
  const b = clamp(parseInt(m[3], 16) + 255 * percent);
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** ROUND-42: the project's tile — a soft vertical gradient derived from the
 * project's own color, with an inner top highlight + soft shadow. Replaces
 * the flat colored square (owner: modern, beautiful, cleaner, smoother).
 * R60-C: the `selected` inset-ring variant died with the collapsed rail —
 * the tile is the expanded-row mark only. */
function ProjectTile({
  color,
  name,
  size = 32,
  radius = 10,
  fontSize = 13,
}: {
  color: string;
  name: string;
  size?: number;
  radius?: number;
  fontSize?: number;
}) {
  return (
    <span
      className="shrink-0 grid place-items-center font-black select-none"
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        fontSize,
        color: "#fff",
        background: `linear-gradient(150deg, ${shadeHex(color, 0.22)} 0%, ${color} 45%, ${shadeHex(color, -0.24)} 100%)`,
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.28), inset 0 -1px 2px rgba(0,0,0,0.18), 0 1px 3px rgba(0,0,0,0.14)",
        textShadow: "0 1px 1px rgba(0,0,0,0.22)",
      }}
      aria-hidden
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

/**
 * AcuteLogo (round-33; ROUND-49 redesign): the custom app mark — a rounded
 * orange tile with a WHITE CAT-FACE SILHOUETTE (owner round-49: "the logo of
 * our application should be a silhouette of the face of a cat… a proper SVG
 * icon… detailed enough"). The mark: two pointed ears, a gently dipping
 * crown, rounded cheeks tapering to a soft chin, two slanted almond eyes and
 * a small triangular nose punched out of the silhouette (evenodd holes, the
 * tile's gradient shows through) — detailed enough to read as a cat face
 * from 16px (favicon) to 52px (chat empty state) without turning to mud.
 * R60-C: a mark WITH a click handler renders a real <button> (hover morphs
 * the mark into a panel-left icon, click toggles); a DECORATIVE mark renders
 * a <span> — the TitleBar's identity control is a <button> that WRAPS the
 * logo, and interactive content may never nest, so the logo inside it is
 * the non-interactive variant. Used by the title-bar identity control, the
 * mobile drawer trigger, the floating show-sidebar button, the chat empty
 * state, and the connection splash — all through the same `size` prop. The
 * mark mirrors public/favicon.svg 1:1.
 */
export function AcuteLogo({
  size = 32,
  hoverToggle = false,
  onClick,
  ariaLabel,
  title,
}: {
  size?: number;
  hoverToggle?: boolean;
  onClick?: () => void;
  ariaLabel?: string;
  title?: string;
}) {
  const [hovered, setHovered] = useState(false);
  // Shared presentation for both element kinds (button when interactive).
  const shared = {
    "aria-label": ariaLabel ?? "Acute",
    title,
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => setHovered(false),
    className: "relative grid place-items-center transition-transform hover:scale-[1.05] active:scale-95",
    style: {
      width: size,
      height: size,
      borderRadius: Math.round(size * 0.28),
      background: "linear-gradient(155deg, #FF8147 0%, #FF6B2C 52%, #ED5A17 100%)",
      boxShadow: "inset 0 1px 0 rgba(255,255,255,0.32), 0 2px 10px rgba(255,107,44,0.35)",
    },
  };
  const mark = (
    <>
      {/* The cat-face silhouette — solid white head with pointed ears; the
          slanted almond eyes + triangular nose are evenodd punch-outs (the
          tile gradient shows through). Fades out on hover when hoverToggle. */}
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          opacity: hoverToggle && hovered ? 0 : 1,
          transition: "opacity 0.15s",
        }}
      >
        <path
          d="M7 13.4 L8 4.8 L12.6 8.8 Q14.2 7.9 16 7.9 Q17.8 7.9 19.4 8.8 L24 4.8 L25 13.4 Q25.5 18 21.2 22 Q18.6 24.8 16 25 Q13.4 24.8 10.8 22 Q6.5 18 7 13.4 Z
             M10.4 15.4 Q11.9 13.2 13.8 14.2 Q12.4 16.3 10.4 15.4 Z
             M21.6 15.4 Q20.1 13.2 18.2 14.2 Q19.6 16.3 21.6 15.4 Z
             M14.9 17.9 H17.1 L16 19.5 Z"
          fill="#FFFFFF"
          fillRule="evenodd"
        />
      </svg>
      {/* The panel-left toggle icon — fades in on hover when hoverToggle */}
      {hoverToggle && (
        <svg
          width={size * 0.55}
          height={size * 0.55}
          viewBox="0 0 24 24"
          fill="none"
          stroke="#FFFFFF"
          strokeWidth={2.2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          style={{
            position: "absolute",
            opacity: hovered ? 1 : 0,
            transition: "opacity 0.15s",
          }}
        >
          <rect x="3" y="3" width="18" height="18" rx="3" />
          <path d="M9 3v18" />
        </svg>
      )}
    </>
  );
  if (onClick === undefined) {
    return <span {...shared}>{mark}</span>;
  }
  return (
    <button type="button" onClick={onClick} {...shared}>
      {mark}
    </button>
  );
}

/**
 * Sidebar (round-33 owner redesign · R60-C refactor):
 * - NO header row in normal mode — R60-C (owner): the app logo lives in the
 *   TITLE BAR now and THAT identity control (logo + name, top-left of the
 *   window) is the one toggle for showing/hiding this whole panel; the
 *   in-sidebar logo + the collapse button + the 64px collapsed rail are
 *   GONE. The panel is either fully visible (AppShell's appSidebarVisible)
 *   or fully absent — no intermediate state, no COLLAPSE_KEY persistence.
 * - SETTINGS mode keeps its header row: back button + "Settings" title.
 * - GENEROUS spacing between NAVIGATION and PROJECTS (owner: "way too close
 *   together").
 * - PROJECTS: no chevron, no session-count chip; the "+ new session" button
 *   lives ON the project row itself (owner directive); sessions are
 *   renameable (round-33).
 * - FOOTER: a PROMINENT Settings button (card-style, not a plain nav row).
 */
/** ROUND-34 (owner design frame 1a): the settings sections that REPLACE the
 * normal navigation when the sidebar is in settings mode. ids stay the
 * SettingsPage tab ids so ?tab= deep links keep working. */
const SETTINGS_SECTIONS = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "api", label: "Models & Providers", icon: Server },
  // ROUND-44 (VLM pass): this entry was MISSING — the R43 Sub-agents tab
  // existed in SettingsPage TABS but the sidebar (the actual settings nav,
  // R34 design) never listed it, making the whole tab unreachable except by
  // hand-typing ?tab=subagents. Owners could not find the key pool at all.
  { id: "subagents", label: "Sub-agents", icon: Users },
  // ROUND-61 (R61, owner directive): the extensibility sections — skills
  // (multiple user-addable prompt modules), MCP servers (user-configured
  // stdio tool servers), computer use (the desktop-control master switch
  // + the separate vision model). Same ids as SettingsPage TABS so the
  // ?tab= deep links line up (the R44 lesson applied at birth).
  { id: "skills", label: "Skills", icon: Sparkles },
  // ROUND-98 (R98-E1/E3, owner directive): the prompt-customization section
  // (per-project system-prompt overrides + the live composed preview). Same
  // id as SettingsPage TABS so the ?tab=prompts deep link lines up — the
  // R44 unreachable-tab lesson applied at birth.
  { id: "prompts", label: "Prompts", icon: FileText },
  { id: "mcp", label: "MCP Servers", icon: PlugZap },
  { id: "computeruse", label: "Computer Use", icon: Monitor },
  // ROUND-66 (R66, owner directive): the dedicated image-analysis section
  // (the vision model's own home, split OUT of Computer Use). Same id as
  // SettingsPage TABS so the ?tab=vision deep link lines up (the R44
  // unreachable-tab lesson applied at birth).
  { id: "vision", label: "Image Analysis", icon: ScanEye },
  // ROUND-97 (R97-G, owner directive): the dedicated BROWSER section (same id
  // as SettingsPage TABS so the ?tab=browser deep link lines up).
  { id: "browser", label: "Browser", icon: Globe },
  // ROUND-98 (R98-I2, owner directive): the Data & Statistics section (same
  // id as SettingsPage TABS so the ?tab=data deep link lines up — the R44
  // unreachable-tab lesson applied at birth).
  { id: "data", label: "Data & Statistics", icon: BarChart3 },
  { id: "advanced", label: "Advanced", icon: SlidersHorizontal },
  // ROUND-87 (R87, owner directive): the About section — version, update
  // check, and the application-wide reset. Same id as SettingsPage TABS
  // so the ?tab=about deep link lines up.
  { id: "about", label: "About", icon: Info },
] as const;

export function Sidebar() {
  const styles = useThemeStyles();
  // ROUND-45 (VLM-pass find): MOBILE DRAWER. Below md the sidebar is a
  // fixed overlay (the old static 270px column left only 69px of content at
  // 375px) — closed by default, opened by the floating logo trigger,
  // closed by the backdrop, and auto-closed on navigation. R60-C: this is
  // the ONLY mobile affordance (mobile has no title bar) — kept exactly.
  const [mobileOpen, setMobileOpen] = useState(false);
  const { pathname, search } = useLocation();
  // ROUND-34: settings mode — the sidebar TRANSFORMS into the settings nav
  // (owner design: "the whole sidebar should change into the settings sidebar").
  const isSettingsRoute = pathname.startsWith("/settings");
  const activeTab = new URLSearchParams(search).get("tab") ?? "appearance";
  const navigate = useNavigate();

  // ROUND-45: any navigation closes the mobile drawer (standard drawer UX).
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname, search]);

  // R60-C: the panel's own visibility is NOT decided here — AppShell's
  // appSidebarVisible (flipped by the TITLE BAR identity control in Tauri,
  // the floating Acute logo in web dev mode) mounts/unmounts this whole
  // component. ROUND-62 (owner: "i should be given the option to minimize
  // it rather than just hiding it completely") adds the SECOND state on
  // top: MINIMIZED — the sidebar becomes its 64px icon rail (nav icons +
  // project tiles + bell/settings) with the restore button at its very
  // top. Orthogonal to the full hide; persisted in the project-chat store.
  const minimized = useProjectChatStore((s) => s.appSidebarMinimized);
  const setAppSidebarMinimized = useProjectChatStore((s) => s.setAppSidebarMinimized);

  return (
    <>
      {/* ROUND-45: mobile backdrop — click to close; md+ unaffected.
          R92-A: data-webview-backdrop — a pure dim scrim (the drawer itself
          is the content), so on a narrow Tauri window it must not be
          recorded as covering the embedded browser (which blanked the page
          for a dim the OS webview never showed). */}
      {mobileOpen && (
        <button
          type="button"
          aria-label="Close menu"
          onClick={() => setMobileOpen(false)}
          data-webview-backdrop
          className="fixed inset-0 z-40 cursor-default bg-black/40 md:hidden"
        />
      )}
      {/* ROUND-45: mobile trigger — the app logo, the ONLY mobile affordance
          (mobile has no title bar to host the R60-C identity toggle); visible
          below md whenever the drawer is closed. R58: in Tauri the custom
          TitleBar owns the top 40px — drop below it. */}
      {!mobileOpen && (
        <div
          className={`fixed left-[10px] z-50 md:hidden ${
            isTauri() ? "top-[50px]" : "top-[10px]"
          }`}
        >
          <AcuteLogo
            size={34}
            hoverToggle
            onClick={() => setMobileOpen(true)}
            ariaLabel="Acute — open menu"
            title="Open menu"
          />
        </div>
      )}
    <motion.aside
      // R60-C: fixed width — the rail↔expanded width animation is GONE with
      // the collapse feature; framer-motion stays mounted only for this
      // subtle 200ms show-in (fade + nudge) so the panel feels alive when the
      // title-bar toggle brings it back. The mobile drawer slide is the
      // Tailwind `translate` property below (it composes with framer's
      // `transform` — different CSS properties).
      // ROUND-62: the width is rail-conditional again (270px full · 64px
      // minimized) with a 200ms width transition so minimizing feels alive.
      initial={{ opacity: 0, x: -14 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
      className={cn(
        "shrink-0 flex flex-col overflow-hidden rounded-[20px] border-[1.5px] transition-[width] duration-200",
        minimized ? "w-[64px]" : "w-[270px]",
        // ROUND-45: below md this is an overlay drawer, not a flex column.
        "max-md:fixed max-md:inset-y-3 max-md:left-3 max-md:z-50 max-md:shadow-2xl",
        mobileOpen ? "max-md:translate-x-0" : "max-md:-translate-x-[120%] max-md:pointer-events-none",
        "max-md:transition-transform max-md:duration-200",
      )}
      aria-label="Main sidebar"
      style={{
        backgroundColor: styles.sidebarBg,
        borderColor: styles.sidebarBorder,
      }}
    >
      {/* R60-C: NO header row in normal mode — the nav starts at the top
          (the logo + collapse button moved out with the rail). ROUND-62: a
          slim MINIMIZE row returns at the very top (owner: "i should be
          given the option at the very top to minimize it") — one icon
          button, right-aligned so it sits where the sidebar meets the chat
          (the direction it shrinks toward); the rail's restore button is
          its mirror. SETTINGS mode (ROUND-34 owner design frame 1a) keeps
          its header: back button + "Settings" title + the same minimize
          control at the row's end. */}
      {/* ROUND-66 (R66, B4, owner report: "when I minimize the settings
          sidebar, it shows me the wrong sidebar — the normal one with the
          projects"): the minimized rail is now MODE-AWARE — on /settings it
          renders the SETTINGS rail (back-to-dashboard + the section icons,
          active = the ?tab=), never the normal projects nav. */}
      {minimized ? (
        <MinimizedRail
          onExpand={() => setAppSidebarMinimized(false)}
          variant={isSettingsRoute ? "settings" : "normal"}
          activeSettingsTab={isSettingsRoute ? activeTab : undefined}
        />
      ) : isSettingsRoute ? (
        /* ── SETTINGS MODE (owner design frame 1a): the sidebar's whole body
           becomes the settings section list (header row first, then nav).
           ─────────────────────────────────────────────────────────────── */
        <>
        <div className="shrink-0 flex items-center gap-2 px-3 pt-3">
          {/* ROUND-95 (R95-A, the owner: "on any of the pages there is no need
              to show the Back to Dashboard page button. The only place where
              the option needs to be shown is in the left sidebar… it is not
              proper so I would like you to improve it and make it a
              better-looking button"): the settings-mode back affordance is a
              PROPER labeled pill now — icon + "Dashboard" in the app's pill
              button idiom (bordered rounded-full h-9, hover fill) instead of
              the old bare 7×7 icon that read as an unlabeled afterthought.
              This is the ONE back-to-dashboard affordance outside the
              minimized rail (the settings pages' own pills are gone). */}
          <button
            onClick={() => navigate("/")}
            aria-label="Back to dashboard"
            title="Back to dashboard"
            data-testid="sidebar-back-dashboard"
            className="h-9 shrink-0 inline-flex items-center gap-1.5 px-3.5 rounded-full border-[1.5px] text-[12px] font-bold transition-colors"
            style={{ borderColor: styles.sidebarBorder, color: styles.textSecondary, background: styles.inputBg }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = styles.sidebarHover;
              e.currentTarget.style.color = styles.text;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = styles.inputBg;
              e.currentTarget.style.color = styles.textSecondary;
            }}
          >
            <ArrowLeft size={13} /> Dashboard
          </button>
          <span className="text-[13px] font-black tracking-tight truncate" style={{ color: styles.text }}>
            Settings
          </span>
          {/* ROUND-62: the minimize control also lives at the very top of the
              settings sidebar (row's end) — same action as normal mode. */}
          <button
            onClick={() => setAppSidebarMinimized(true)}
            aria-label="Minimize sidebar"
            title="Minimize sidebar"
            data-testid="sidebar-minimize"
            className="w-7 h-7 shrink-0 ml-auto rounded-[9px] grid place-items-center transition-colors"
            style={{ color: styles.textTertiary }}
            onMouseEnter={(e) => (e.currentTarget.style.background = styles.sidebarHover)}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            <PanelLeftClose size={14} />
          </button>
        </div>
        <nav className="flex-1 flex flex-col gap-1 px-2.5 pt-3 overflow-y-auto" aria-label="Settings sections">
          {SETTINGS_SECTIONS.map(({ id, label, icon: Icon }) => {
            const active = activeTab === id;
            return (
              <button
                key={id}
                onClick={() => navigate(`/settings?tab=${id}`)}
                aria-current={active ? "true" : undefined}
                className="relative h-11 flex items-center gap-2.5 px-2.5 rounded-[12px] transition-all duration-200 text-[13px] font-bold"
                style={{
                  background: active ? withAlpha(styles.accent, 0.12) : "transparent",
                  color: active ? styles.text : styles.textSecondary,
                }}
                onMouseEnter={(e) => {
                  if (!active) e.currentTarget.style.background = styles.sidebarHover;
                }}
                onMouseLeave={(e) => {
                  if (!active) e.currentTarget.style.background = "transparent";
                }}
              >
                {/* Active indicator bar — same language as session rows. */}
                {active && (
                  <span
                    className="absolute left-0 top-1.5 bottom-1.5 w-[2.5px] rounded-full"
                    style={{ background: styles.accent }}
                    aria-hidden
                  />
                )}
                <span
                  className="w-7 h-7 shrink-0 rounded-[9px] grid place-items-center"
                  style={{
                    background: active ? withAlpha(styles.accent, 0.14) : styles.inputBg,
                    color: active ? styles.accent : styles.textSecondary,
                  }}
                >
                  <Icon size={14} />
                </span>
                <span className="truncate">{label}</span>
              </button>
            );
          })}
          {/* The dashed "more coming" slot (owner design: future sections). */}
          <div
            className="mt-1 h-10 flex items-center justify-center rounded-[12px] border-[1.5px] border-dashed text-[11px] font-bold"
            style={{ borderColor: styles.sidebarBorder, color: styles.textTertiary }}
          >
            More settings coming soon
          </div>
        </nav>
        </>
      ) : (
        <>
          {/* ROUND-62: the MINIMIZE row — the owner's directive ("option at
              the very top to minimize it"). One quiet icon button,
              right-aligned where the panel meets the chat (the direction it
              shrinks toward); its mirror is the rail's expand button. */}
          <div className="shrink-0 flex items-center justify-end px-2.5 pt-2.5 pb-0.5">
            <button
              onClick={() => setAppSidebarMinimized(true)}
              aria-label="Minimize sidebar"
              title="Minimize sidebar"
              data-testid="sidebar-minimize"
              className="w-7 h-7 rounded-[9px] grid place-items-center transition-colors"
              style={{ color: styles.textTertiary }}
              onMouseEnter={(e) => (e.currentTarget.style.background = styles.sidebarHover)}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <PanelLeftClose size={15} />
            </button>
          </div>

          {/* NAVIGATION SECTION — dedicated section for Dashboard + Usage.
              ROUND-42: same heading language as the refreshed Projects
              header (heavier weight, wider tracking). */}
          <div className="shrink-0 flex items-center px-4 pt-3 pb-1.5">
            <span
              className="text-[10.5px] font-black uppercase tracking-[0.14em]"
              style={{ color: styles.textTertiary }}
            >
              Navigation
            </span>
          </div>
          <nav
            className="flex flex-col gap-1 px-2.5 pb-3 pt-1"
            aria-label="Main navigation"
            // ROUND-45: any nav interaction closes the mobile drawer — even a
            // same-route click (the useLocation effect only fires on change).
            onClickCapture={() => setMobileOpen(false)}
          >
            <DashboardButton />
            <UsageButton />
          </nav>

          {/* Divider — generous spacing around it (owner round-33). */}
          <div className="shrink-0 mx-3 my-4 border-t-[1.5px]" style={{ borderColor: styles.sidebarBorder }} />

          {/* PROJECTS SECTION — expandable tree */}
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
            <ProjectSection />
          </div>

          {/* FOOTER — a PROMINENT Settings button (owner round-33) + the
              ROUND-40 NotificationBell (bell icon + unread badge + dropdown).
              The bell mounts beside Settings as the closest analog to
              "header actions" in this app's chrome. */}
          <div
            className="shrink-0 border-t px-2.5 pb-3 pt-2.5"
            style={{ borderColor: styles.sidebarBorder }}
          >
            {/* ROUND-40: small icon row above the prominent Settings button —
                the bell icon aligned to the right (the footer's right-aligned
                language). R62: still expanded-only in the full sidebar (the
                RAIL has its own collapsed bell). */}
            <div className="flex items-center mb-1.5 justify-end">
              <NotificationBell collapsed={false} />
            </div>
            <SettingsButton />
          </div>
        </>
      )}
    </motion.aside>
    </>
  );
}

/**
 * ROUND-62 (owner: "i should be given the option to minimize it rather than
 * just hiding it completely") — the sidebar's MINIMIZED icon rail: a 64px
 * column with the restore button at the very top, then Dashboard/Usage, the
 * project tiles (click → that project's chat; the running dot carries the
 * live-work signal), a flexible spacer, and the collapsed bell + settings
 * gear at the bottom. Every button carries a `title` tooltip so the rail
 * stays fully usable without labels. The mobile drawer reuses the same rail
 * body (a narrow drawer of icons is still perfectly navigable).
 */
/** ROUND-66 (R66): the rail's MODE — "normal" (dashboard/usage/projects)
 * or "settings" (the settings section icons — the owner's B4 report: the
 * minimized settings sidebar must NOT fall back to the projects rail). */
export type RailVariant = "normal" | "settings";

function MinimizedRail({
  onExpand,
  variant = "normal",
  activeSettingsTab,
}: {
  onExpand: () => void;
  variant?: RailVariant;
  /** The ?tab= id to mark active in the settings rail. */
  activeSettingsTab?: string;
}) {
  const styles = useThemeStyles();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const projectsQuery = useProjects();
  const sessionsQuery = useSessions();
  const projects = projectsQuery.data ?? [];
  const sessions = sessionsQuery.data ?? [];
  // ROUND-42 parity: a project with any running session shows the live dot.
  const runningSessions = useActiveStreams((s) => s.active);
  const runningProjects = new Set(
    sessions.filter((s) => runningSessions.has(s.id)).map((s) => s.projectId),
  );
  const activeProjectId = pathname.match(/^\/project\/([^/]+)/)?.[1] ?? null;
  const settingsActive = pathname.startsWith("/settings");

  const railBtn = (
    label: string,
    icon: ReactNode,
    active: boolean,
    onClick: () => void,
    testId?: string,
  ) => (
    <button
      onClick={onClick}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      title={label}
      data-testid={testId}
      className="w-10 h-10 shrink-0 grid place-items-center rounded-[12px] transition-all duration-200"
      style={{
        background: active ? styles.accent : "transparent",
        color: active ? styles.accentText : styles.textSecondary,
        boxShadow: active ? `0 2px 8px ${withAlpha(styles.accent, 0.3)}` : "none",
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = styles.sidebarHover;
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = "transparent";
      }}
    >
      {icon}
    </button>
  );

  return (
    <div
      className="flex-1 min-h-0 flex flex-col items-center gap-1.5 px-1.5 pt-2.5 pb-2.5 overflow-y-auto"
      data-testid="sidebar-rail"
    >
      {/* RESTORE — at the rail's very top (the minimize button's mirror). */}
      <button
        onClick={onExpand}
        aria-label="Expand sidebar"
        title="Expand sidebar"
        data-testid="sidebar-expand"
        className="w-10 h-10 shrink-0 grid place-items-center rounded-[12px] transition-colors"
        style={{ color: styles.textTertiary, background: styles.inputBg }}
        onMouseEnter={(e) => (e.currentTarget.style.background = styles.sidebarHover)}
        onMouseLeave={(e) => (e.currentTarget.style.background = styles.inputBg)}
      >
        <PanelLeftOpen size={16} />
      </button>

      {/* ROUND-66 (R66, B4): the SETTINGS rail — back-to-dashboard + the
          section icons (active = the ?tab= deep-link id), mirroring the
          expanded settings sidebar's list exactly (same ids, same order).
          The projects nav is deliberately NOT here: minimizing a settings
          page must not teleport the owner into the projects world (his
          report, verbatim: "it shows me the wrong sidebar"). */}
      {variant === "settings" ? (
        <>
          {railBtn(
            "Back to dashboard",
            <ArrowLeft size={17} strokeWidth={2} />,
            false,
            () => navigate("/"),
            "rail-back-dashboard",
          )}
          <div className="w-8 shrink-0 border-t-[1.5px] my-1" style={{ borderColor: styles.sidebarBorder }} />
          {SETTINGS_SECTIONS.map(({ id, label, icon: Icon }) => (
            <Fragment key={id}>
              {railBtn(
                label,
                <Icon size={17} strokeWidth={2} />,
                activeSettingsTab === id,
                () => navigate(`/settings?tab=${id}`),
                `rail-settings-${id}`,
              )}
            </Fragment>
          ))}
        </>
      ) : (
        <>
      {railBtn("Dashboard", <LayoutDashboard size={17} strokeWidth={2} />, pathname === "/", () => navigate("/"), "rail-dashboard")}
      {railBtn("Usage", <BarChart3 size={17} strokeWidth={2} />, pathname.startsWith("/usage"), () => navigate("/usage"), "rail-usage")}

      {/* Hairline divider (the full sidebar's section divider, rail-sized). */}
      <div className="w-8 shrink-0 border-t-[1.5px] my-1" style={{ borderColor: styles.sidebarBorder }} />

      {/* PROJECT TILES — click opens the project's chat; the tile is the
          project's own gradient mark (ProjectTile), so color identity
          survives minimization; running projects get the live dot.
          R87-A1 (owner: "if I click on any one of the projects, then the
          left sidebar should apparently expand fully"): the click EXPANDS
          the sidebar first (the same onExpand the rail's top restore button
          uses), then navigates — a rail tile is a shortcut INTO the project
          world, and the projects list lives in the full panel. */}
      <div className="flex flex-col items-center gap-1.5 py-0.5" data-testid="rail-projects">
        {projectsQuery.isPending ? (
          /* R97-I part 2 (owner: a UI "aware of its states"): the projects
             strip holds its SHAPE while the list is in flight — 4 skeleton
             tiles in the real tile button's exact geometry (w-10 h-10, the
             primitives' 12px radius), never a blank rail that reads as
             "no projects". Decorative on purpose: the rail stays quiet; the
             expanded sidebar owns the one role=status announcement. On
             ERROR the rail renders nothing extra — the full sidebar owns the
             retryable error surface. */
          <SkeletonRows rows={4} rowClassName="w-10 h-10" gap={1.5} />
        ) : (
          projects.slice(0, 10).map((project) => {
            const active = activeProjectId === project.id;
            const running = runningProjects.has(project.id);
            return (
              <button
                key={project.id}
                onClick={() => {
                  onExpand();
                  navigate(`/project/${project.id}/chat`);
                }}
                aria-label={`Open ${project.name}`}
                title={project.name}
                aria-current={active ? "page" : undefined}
                className="relative w-10 h-10 shrink-0 grid place-items-center rounded-[12px] transition-all duration-200"
                style={{
                  background: active ? withAlpha(project.color, 0.14) : "transparent",
                  border: active ? `1.5px solid ${withAlpha(project.color, 0.4)}` : "1.5px solid transparent",
                }}
                onMouseEnter={(e) => {
                  if (!active) e.currentTarget.style.background = styles.sidebarHover;
                }}
                onMouseLeave={(e) => {
                  if (!active) e.currentTarget.style.background = "transparent";
                }}
              >
                <ProjectTile color={project.color} name={project.name} size={26} radius={8} fontSize={11} />
                {running && (
                  <span
                    aria-label="Running"
                    className="absolute -top-0.5 -right-0.5 w-[10px] h-[10px] rounded-full border-2"
                    style={{ background: styles.accent, borderColor: styles.sidebarBg }}
                  />
                )}
              </button>
            );
          })
        )}
      </div>

      {/* Spacer pushes the footer icons to the bottom (the full sidebar's
          footer rhythm). */}
      <div className="flex-1 min-h-2" />

      {/* FOOTER — collapsed bell (its own rail variant) + settings gear.
          R66: inside the settings-variant conditional, so the settings rail
          ends after the section icons (no projects footer there). */}
      <NotificationBell collapsed />
      {railBtn("Settings", <Settings size={17} strokeWidth={2} />, settingsActive, () => navigate("/settings"), "rail-settings")}
        </>
      )}
    </div>
  );
}

function NavButton({
  icon: Icon, label, active, onClick,
}: {
  icon: typeof LayoutDashboard; label: string; active: boolean; onClick: () => void;
}) {
  const styles = useThemeStyles();
  return (
    <button
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className="h-10 flex items-center px-3 gap-2.5 rounded-[12px] transition-all duration-200 text-[13px] font-bold"
      style={{
        background: active ? styles.accent : "transparent",
        color: active ? styles.accentText : styles.textSecondary,
        boxShadow: active ? `0 2px 8px ${withAlpha(styles.accent, 0.3)}` : "none",
      }}
      onMouseEnter={(e) => {
        if (!active) { e.currentTarget.style.background = styles.sidebarHover; e.currentTarget.style.color = styles.text; }
      }}
      onMouseLeave={(e) => {
        if (!active) { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = styles.textSecondary; }
      }}
    >
      <Icon size={16} strokeWidth={2} className="shrink-0" />
      <span>{label}</span>
    </button>
  );
}

function DashboardButton() {
  const navigate = useNavigate();
  const active = useLocation().pathname === "/";
  return <NavButton icon={LayoutDashboard} label="Dashboard" active={active} onClick={() => navigate("/")} />;
}

function UsageButton() {
  const navigate = useNavigate();
  const active = useLocation().pathname.startsWith("/usage");
  return <NavButton icon={BarChart3} label="Usage" active={active} onClick={() => navigate("/usage")} />;
}

/** ROUND-48 removed the Sessions nav entry; ROUND-49 removed the /sessions
 * route + SessionsScreen entirely (owner: "completely remove the sessions
 * navigation. It should not be available anywhere in our project at all").
 * Sessions live on INSIDE each project (its chat conversations). */

/** Prominent Settings button (owner round-33): a card-style row — icon tile
 * in an accent-tinted square + bold label — visually distinct from the plain
 * nav rows above the divider. R60-C: expanded card only (the collapsed gear
 * tile went with the rail). */
function SettingsButton() {
  const styles = useThemeStyles();
  const navigate = useNavigate();
  const active = useLocation().pathname.startsWith("/settings");
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={() => navigate("/settings")}
      aria-current={active ? "page" : undefined}
      className="w-full h-11 flex items-center gap-2.5 px-2.5 rounded-[12px] border-[1.5px] transition-all hover:-translate-y-px"
      style={{
        background: active ? withAlpha(styles.accent, 0.12) : styles.card,
        borderColor: active ? withAlpha(styles.accent, 0.4) : styles.border,
        boxShadow: hovered ? styles.softShadow : "none",
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span
        className="w-7 h-7 rounded-[9px] grid place-items-center shrink-0"
        style={{ background: withAlpha(styles.accent, 0.13), color: styles.accent }}
      >
        <Settings size={14} />
      </span>
      <span className="text-[13px] font-bold" style={{ color: styles.text }}>
        Settings
      </span>
    </button>
  );
}

/** Projects section — expandable tree with sessions under each project.
 * ROUND-42 (owner): refreshed visuals — section header with a count chip +
 * ghost Add button, gradient project tiles, a smoother expand animation, and
 * the pixel-stream activity animation on a project row whenever ANY of its
 * sessions is running (even when the project is collapsed — the owner: "the
 * animation should move on to the project itself so I can clearly know which
 * project is active"). R60-C: expanded layout only (the rail is gone). */
function ProjectSection() {
  const styles = useThemeStyles();
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const projectsQuery = useProjects();
  const sessionsQuery = useSessions();
  const projects = projectsQuery.data ?? [];
  const sessions = sessionsQuery.data ?? [];
  const [expandedProjects, setExpandedProjects] = useState<string[]>(readExpanded);
  const [showAddDialog, setShowAddDialog] = useState(false);

  // ROUND-42: the set of running session ids (SSE/stream-driven store) →
  // which PROJECTS currently have live work. Drives the animation on the
  // project row (R60-C: the rail-tile variant is gone — the row is the only
  // carrier now).
  const runningSessions = useActiveStreams((s) => s.active);
  const runningProjects = new Set(
    sessions.filter((s) => runningSessions.has(s.id)).map((s) => s.projectId),
  );

  const activeProjectMatch = pathname.match(/^\/project\/([^/]+)/);
  const activeProjectId = activeProjectMatch?.[1] ?? null;
  // ROUND-30: the ?session= param is the authoritative selection (the chat
  // panel binds to it too) — highlight the matching session row.
  const activeSessionId = new URLSearchParams(search).get("session");

  // Auto-expand the active project
  useEffect(() => {
    if (activeProjectId && !expandedProjects.includes(activeProjectId)) {
      setExpandedProjects((prev) => [...prev, activeProjectId]);
    }
  }, [activeProjectId]);

  useEffect(() => {
    try { localStorage.setItem(EXPANDED_KEY, JSON.stringify(expandedProjects)); } catch { /* */ }
  }, [expandedProjects]);

  const toggleProject = (projectId: string) => {
    setExpandedProjects((prev) =>
      prev.includes(projectId) ? prev.filter((id) => id !== projectId) : [...prev, projectId],
    );
  };

  const projectSessions = (projectId: string) =>
    sessions.filter((s) => s.projectId === projectId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  // ROUND-33: session creation happens from the project row's + button (and
  // still from the bottom row). Uses the query hook so the list UPDATES
  // INSTANTLY (owner: "I have to refresh the whole page" — the old raw-fetch
  // button never invalidated the sessions query).
  const createSession = useCreateSession();
  const createSessionFor = async (projectId: string, projectName: string) => {
    const agentId = agentsForNewSessions();
    if (!agentId) return;
    try {
      const created = await createSession.mutateAsync({
        mode: "single" as const,
        agentId,
        projectId,
        title: `New chat · ${projectName}`,
      });
      navigate(`/project/${projectId}/chat?session=${created.id}`);
    } catch {
      /* surfaced by the mutation state; keep the sidebar stable */
    }
  };
  const agentsQueryForSessions = useAgents(false);
  const agentsForNewSessions = () => (agentsQueryForSessions.data ?? [])[0]?.id ?? null;

  // R60-C: the collapsed-rail early return is DELETED (along with the rail
  // itself) — the expanded tree below is the only layout.

  return (
    <>
      {/* ROUND-42: refreshed section header — bold uppercase label + a mono
          count chip + a ghost icon Add button (owner: "the project headings
          do not look proper… make them modern, cleaner, smoother"). */}
      <div className="flex items-center justify-between px-4 pb-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className="text-[10.5px] font-black uppercase tracking-[0.14em]"
            style={{ color: styles.textTertiary }}
          >
            Projects
          </span>
          {projects.length > 0 ? (
            <span
              className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded-full tabular-nums"
              style={{ color: styles.textTertiary, background: styles.subtle }}
            >
              {projects.length}
            </span>
          ) : null}
        </div>
        <button
          onClick={() => setShowAddDialog(true)}
          title="Add project"
          aria-label="Add project"
          className="w-6 h-6 grid place-items-center rounded-[8px] transition-all hover:scale-110 active:scale-95"
          style={{ color: styles.accent, background: withAlpha(styles.accent, 0.1) }}
        >
          <Plus size={13} strokeWidth={2.5} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2.5 pb-2 space-y-0.5" style={{ scrollbarWidth: "thin" }}>
        {/* R97-I part 2 (owner: a UI "aware of its states") — LOADING: 4
            skeleton rows in the real ProjectRow's exact geometry (h-11, the
            primitives' 12px radius, the list's space-y-0.5 rhythm) hold the
            section open while the query is in flight. Pre-R97 this area
            flashed the FALSE "Add your first project" on every first paint. */}
        {projectsQuery.isPending && (
          <div role="status" aria-label="Loading projects" data-projects-skeleton>
            <SkeletonRows rows={4} rowClassName="h-11" gap={0.5} />
          </div>
        )}

        {/* R97-I part 2 — ERROR: an honest retryable row (role=alert, the
            danger token, one action) instead of silently degrading to the
            empty state. Retry re-drives BOTH sidebar queries — the sessions
            note below rides this button (it carries no retry of its own). */}
        {projectsQuery.isError && (
          <div
            role="alert"
            data-projects-load-error
            className="h-10 flex items-center justify-between gap-2 rounded-[12px] border-[1.5px] px-3"
            style={{
              borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.35),
              background: withAlpha(SEMANTIC_COLORS.danger, styles.isDark ? 0.08 : 0.05),
            }}
          >
            <span className="text-[11.5px] font-bold truncate" style={{ color: SEMANTIC_COLORS.danger }}>
              Projects failed to load
            </span>
            <button
              type="button"
              onClick={() => {
                void projectsQuery.refetch();
                void sessionsQuery.refetch();
              }}
              aria-label="Retry loading projects"
              className="shrink-0 h-7 px-2.5 rounded-lg text-[11px] font-bold border transition-opacity hover:opacity-85"
              style={{ borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.45), color: SEMANTIC_COLORS.danger }}
            >
              Retry
            </button>
          </div>
        )}

        {/* R97-I part 2 — the sessions join failed while projects still
            render: one dimmed line under the list (role=alert so it is never
            silent, but deliberately quiet — retry rides the projects error
            row's button above). */}
        {!projectsQuery.isPending && sessionsQuery.isError && (
          <p
            role="alert"
            data-sessions-load-error
            className="px-2 py-1.5 text-[10.5px]"
            style={{ color: styles.textTertiary }}
          >
            Sessions failed to load — Retry above reloads them too.
          </p>
        )}

        {projects.map((project) => {
          const isExpanded = expandedProjects.includes(project.id);
          const isActive = activeProjectId === project.id;
          const projSessions = projectSessions(project.id);

          return (
            <div key={project.id}>
              {/* Project row — click toggles sessions; the + button starts a
                  new session directly (owner round-33). ROUND-42: gradient
                  tile + the running animation lives HERE when collapsed. */}
              <ProjectRow
                project={project}
                active={isActive}
                expanded={isExpanded}
                running={runningProjects.has(project.id)}
                onToggle={() => toggleProject(project.id)}
                onNewSession={() => void createSessionFor(project.id, project.name)}
              />
              {/* Sessions underneath */}
              <AnimatePresence initial={false}>
                {isExpanded && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.22, ease: [0.25, 0.1, 0.25, 1] }}
                    className="overflow-hidden"
                  >
                    {/* ROUND-43: the tree rail is softened to a hairline so the
                        bordered session rows (below) carry the depth. */}
                    <div className="ml-[19px] pl-2.5 border-l space-y-1 py-1" style={{ borderColor: withAlpha(styles.textTertiary, 0.14) }}>
                      {projSessions.slice(0, 8).map((session) => (
                        <SessionRow
                          key={session.id}
                          session={session}
                          projectId={project.id}
                          active={session.id === activeSessionId}
                        />
                      ))}
                      {projSessions.length > 8 && (
                        <span className="block px-2 py-1 text-[10px]" style={{ color: styles.textTertiary }}>
                          +{projSessions.length - 8} more
                        </span>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}

        {/* R97-I part 2 — the TRUE empty state: only when the list has
            SETTLED (not pending, not failed) is "no projects" a fact.
            Pre-R97 this button painted on every first paint + every fetch
            failure. */}
        {!projectsQuery.isPending && !projectsQuery.isError && projects.length === 0 && (
          <button
            onClick={() => setShowAddDialog(true)}
            className="h-10 w-full flex items-center justify-center gap-2 rounded-[14px] border-[1.5px] border-dashed text-[12px] font-bold transition-all hover:-translate-y-px"
            style={{ borderColor: styles.border, background: "transparent", color: styles.textTertiary }}
          >
            <Plus size={13} strokeWidth={2.5} />
            <span>Add your first project</span>
          </button>
        )}
      </div>

      {showAddDialog && (
        <AddProjectDialog onCreated={(id) => navigate(`/project/${id}/chat`)} onClose={() => setShowAddDialog(false)} />
      )}
    </>
  );
}

function ProjectRow({
  project, active, expanded, running, onToggle, onNewSession,
}: {
  project: Project;
  active: boolean;
  expanded: boolean;
  /** ROUND-42: any session of this project has a turn in flight — the
   * activity animation moves onto the project row itself (owner: "if the
   * session is going on and I collapse the project, the animation should
   * move on to the project itself"). */
  running: boolean;
  onToggle: () => void;
  onNewSession: () => void;
}) {
  const styles = useThemeStyles();
  const [hovered, setHovered] = useState(false);

  return (
    <div
      className="group relative h-11 flex items-center gap-2.5 rounded-[12px] px-2 cursor-pointer transition-all duration-200"
      style={{
        // ROUND-48 (R48-a): the active highlight follows the PROJECT'S OWN
        // color (withAlpha tint), not the theme accent — with per-project
        // palette colors the whole row now reads as belonging to that
        // project (owner: "projects should be given different colors").
        border: active ? `1.5px solid ${withAlpha(project.color, 0.4)}` : "1.5px solid transparent",
        background: active
          ? withAlpha(project.color, 0.1)
          : hovered
            ? styles.sidebarHover
            : "transparent",
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onToggle}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter") onToggle(); }}
      aria-expanded={expanded}
      aria-label={`Project ${project.name} — click to ${expanded ? "collapse" : "expand"} sessions${running ? " (working)" : ""}`}
    >
      {/* ROUND-42: gradient tile (owner: "the project's actual images need
          to be a bit better"). */}
      <ProjectTile color={project.color} name={project.name} size={32} radius={10} fontSize={13} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span
          className="text-[12px] font-bold truncate"
          style={{ color: active ? styles.text : styles.textSecondary }}
        >
          {project.name}
        </span>
      </div>
      {/* ROUND-42: live-work animation on the project row — the clear "this
          project is making changes right now" signal when the sessions are
          collapsed (or while scanning the list). */}
      {running ? (
        <span
          className="shrink-0 mr-0.5 ac-pixel-stream"
          style={{ color: styles.accent }}
          role="status"
          title="A session in this project is working…"
          aria-label="A session in this project is working"
        >
          <span /><span /><span /><span />
        </span>
      ) : null}
      {/* ROUND-33 (owner): the "+ new session" button lives ON the project row
          itself; no chevron, no session count. */}
      <button
        onClick={(e) => { e.stopPropagation(); onNewSession(); }}
        aria-label={`Start new session in ${project.name}`}
        title="New session"
        className="relative z-20 w-6 h-6 grid place-items-center rounded-md transition-all hover:scale-110"
        style={{
          color: styles.accent,
          opacity: hovered ? 1 : 0,
          background: hovered ? withAlpha(styles.accent, 0.1) : "transparent",
        }}
      >
        <Plus size={13} strokeWidth={2.5} />
      </button>
      <DeleteProjectButton projectId={project.id} projectName={project.name} visible={hovered} />
    </div>
  );
}

/** The visual state of a session row — drives the border tint, the leading
 * icon and the test attributes (ROUND-43). */
export type SessionRowState = "running" | "failed" | "idle";

export function deriveSessionRowState(session: Session, running: boolean): SessionRowState {
  if (running || session.status === "running") return "running";
  if (session.status === "failed" || session.status === "cancelled") return "failed";
  return "idle";
}

/**
 * ROUND-33 SessionRow · ROUND-43 depth pass (owner: “each individual session
 * could be given a dedicated border around it… the icons could be improved
 * and handled better”). Every row is now its own bordered card — hairline
 * neutral border at rest, stronger on hover, accent-tinted when ACTIVE —
 * with a 1-level shadow + inset highlight matching the R42 ProjectTile
 * gradient language. The leading icon is STATE-AWARE: spinner while a turn
 * is in flight, chat bubble at rest, alert glyph on failed/cancelled
 * sessions. The R38 pixel-stream on the right is preserved and composes
 * with the running icon (rail-side flourish + at-a-glance state).
 * ACTIVE session (matching the ?session= URL param) keeps the accent fill,
 * bold text + 2.5px indicator bar. Hover reveals RENAME (round-33) and
 * DELETE (round-30). Rename switches to an inline input (Enter · Escape).
 */
function SessionRow({
  session,
  projectId,
  active,
}: {
  session: Session;
  projectId: string;
  active: boolean;
}) {
  const styles = useThemeStyles();
  const navigate = useNavigate();
  const location = useLocation();
  const deleteSession = useDeleteSession();
  const renameSession = useRenameSession();
  const [hovered, setHovered] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title ?? "");
  // ROUND-38: pixelated activity indicator on the right when this session
  // has a turn in flight (owner directive).
  const streaming = useActiveStreams((s) => s.active.has(session.id));
  // ROUND-43: coherent row state (icon + tint + test attributes).
  const state = deriveSessionRowState(session, streaming);
  const running = state === "running";

  const remove = () => {
    deleteSession.mutate(session.id, {
      onSuccess: () => {
        if (location.search.includes(session.id)) {
          navigate(`/project/${projectId}/chat`, { replace: true });
        }
      },
    });
  };

  const commitRename = () => {
    const next = draft.trim();
    setEditing(false);
    if (next !== (session.title ?? "")) {
      renameSession.mutate({ id: session.id, title: next });
    }
  };

  // Inline rename input state.
  if (editing) {
    return (
      <div className="flex items-center gap-1.5 px-1 py-0.5">
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") setEditing(false);
          }}
          onBlur={commitRename}
          aria-label="Rename session"
          className="flex-1 min-w-0 h-6 px-2 rounded-[6px] border-[1.5px] text-[11px] outline-none"
          style={{
            background: styles.card,
            borderColor: withAlpha(styles.accent, 0.5),
            color: styles.text,
          }}
        />
        <button
          onClick={() => setEditing(false)}
          aria-label="Cancel rename"
          className="w-5 h-5 grid place-items-center rounded-md shrink-0"
          style={{ color: styles.textTertiary }}
        >
          <X size={10} />
        </button>
      </div>
    );
  }

  // ROUND-43: the dedicated border — neutral hairline at rest, stronger on
  // hover, accent-tinted on the active row; a failed session leans red so
  // the problem row is findable at a glance.
  const borderColor = active
    ? withAlpha(styles.accent, 0.45)
    : state === "failed"
      ? withAlpha(SEMANTIC_COLORS.danger, hovered ? 0.5 : 0.35)
      : hovered
        ? styles.border
        : styles.borderSubtle;
  // Depth consistent with the R42 ProjectTile treatment: a 1-level shadow +
  // a soft inset top highlight (instead of heavier borders).
  const rowShadow = active
    ? styles.isDark
      ? `inset 0 1px 0 rgba(255,255,255,0.06), 0 1px 4px ${withAlpha(styles.accent, 0.25)}`
      : `inset 0 1px 0 rgba(255,255,255,0.8), 0 1px 4px ${withAlpha(styles.accent, 0.18)}`
    : styles.isDark
      ? "inset 0 1px 0 rgba(255,255,255,0.04), 0 1px 2px rgba(0,0,0,0.22)"
      : "inset 0 1px 0 rgba(255,255,255,0.65), 0 1px 2px rgba(0,0,0,0.05)";

  return (
    <div
      data-session-row
      data-state={state}
      data-active={active ? "true" : "false"}
      className="group relative flex items-center gap-0.5 rounded-[9px] pl-0.5 pr-1 py-[3px] transition-all duration-150"
      style={{
        border: `1px solid ${borderColor}`,
        background: active
          ? withAlpha(styles.accent, 0.1)
          : state === "failed"
            ? hovered
              ? withAlpha(SEMANTIC_COLORS.danger, 0.08)
              : withAlpha(SEMANTIC_COLORS.danger, 0.05)
            : hovered
              ? styles.sidebarHover
              : styles.subtle,
        boxShadow: rowShadow,
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Active indicator bar — the clear "currently selected" signal,
          sitting just inside the row's border. */}
      <span
        className="absolute left-[3px] top-1 bottom-1 w-[2.5px] rounded-full transition-opacity"
        style={{ background: styles.accent, opacity: active ? 1 : 0 }}
        aria-hidden
      />
      <button
        onClick={() => navigate(`/project/${projectId}/chat?session=${session.id}`)}
        aria-current={active ? "true" : undefined}
        className="flex-1 min-w-0 h-[26px] flex items-center gap-2 px-2 text-[11px] truncate"
        style={{
          color: active ? styles.text : hovered ? styles.textSecondary : styles.textTertiary,
          fontWeight: active ? 700 : 500,
        }}
        title={session.title ?? "Untitled"}
      >
        {/* ROUND-43 state-aware icon: running → spinner, failed → alert,
            idle → chat bubble. */}
        {state === "running" ? (
          <LoaderCircle
            size={11}
            className="shrink-0 animate-spin"
            style={{ color: styles.accent }}
            aria-label="Session is working"
          />
        ) : state === "failed" ? (
          <CircleAlert
            size={11}
            className="shrink-0"
            style={{ color: SEMANTIC_COLORS.danger }}
            aria-label="Session failed"
          />
        ) : (
          <MessageSquare
            size={10}
            className="shrink-0"
            style={{ color: active ? styles.accent : styles.textTertiary }}
          />
        )}
        <span className="truncate">{session.title ?? "Untitled"}</span>
      </button>
      {/* Rename (round-33) — ROUND-42: smooth opacity transition. */}
      <button
        onClick={(e) => { e.stopPropagation(); setDraft(session.title ?? ""); setEditing(true); }}
        aria-label={`Rename session ${session.title ?? "Untitled"}`}
        title="Rename session"
        className="relative z-10 w-5 h-5 grid place-items-center rounded-md transition-opacity duration-150 hover:bg-black/10"
        style={{ color: styles.textTertiary, opacity: hovered ? 1 : 0 }}
      >
        <Pencil size={10} />
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); remove(); }}
        disabled={deleteSession.isPending}
        aria-label={`Delete session ${session.title ?? "Untitled"}`}
        title="Delete session"
        className="relative z-10 w-5 h-5 grid place-items-center rounded-md transition-opacity duration-150 hover:bg-black/10"
        style={{ color: styles.textTertiary, opacity: hovered ? 1 : 0 }}
      >
        <Trash2 size={10} />
      </button>
      {/* ROUND-38 (owner: "the currently running session will have some
          animation to it, like a pixelated kind of animation playing along
          on the right side"). Shown only while a turn is in flight —
          composes with the ROUND-43 running icon on the left. */}
      {running ? (
        <span
          className="shrink-0 ac-pixel-stream"
          style={{ color: styles.accent }}
          aria-label="Session is working"
          role="status"
          title="Working…"
        >
          <span /><span /><span /><span />
        </span>
      ) : null}
    </div>
  );
}

function DeleteProjectButton({
  projectId, projectName, visible,
}: {
  projectId: string; projectName: string; visible: boolean;
}) {
  const styles = useThemeStyles();
  const { remove } = useDeleteProjectSimple();
  return (
    <button
      onClick={(e) => { e.stopPropagation(); remove(projectId); }}
      aria-label={`Delete ${projectName}`}
      title={`Delete ${projectName}`}
      className="relative z-20 w-6 h-6 grid place-items-center rounded-md transition-opacity"
      style={{ color: styles.textTertiary, opacity: visible ? 1 : 0 }}
    >
      <Trash2 size={11} />
    </button>
  );
}

function useDeleteProjectSimple() {
  const deleteProject = useDeleteProject();
  const remove = useCallback(
    (id: string) => deleteProject.mutate(id),
    [deleteProject],
  );
  return { remove };
}



// ─── Add Project Dialog ──────────────────────────────────────────────────────

function AddProjectDialog({
  onCreated, onClose,
}: {
  onCreated: (projectId: string) => void; onClose: () => void;
}) {
  const styles = useThemeStyles();
  const [rootPath, setRootPath] = useState("");
  const [picking, setPicking] = useState(false);
  const [pickHint, setPickHint] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  
  const pathRef = useRef<HTMLInputElement>(null);
  const demoData = useConfigStore((s) => s.demoData);

  useEffect(() => {
    const timer = setTimeout(() => pathRef.current?.focus(), 60);
    return () => clearTimeout(timer);
  }, []);

  const handleBrowse = useCallback(async () => {
    setPicking(true);
    // R54: immediate feedback while the OS dialog opens — the owner's browser
    // reports showed a silent spinner with no hint that pasting always works.
    setPickHint("Opening the system folder dialog…");
    try {
      if (isTauri()) {
        const folder = await tauriInvoke<string | null>("pick_folder");
        if (typeof folder === "string" && folder) setRootPath(folder);
        setPickHint(null);
        return;
      }
      const picked = await pickFolderViaBackend();
      if (picked.path) {
        setRootPath(picked.path);
        setPickHint(null);
      } else if (picked.unavailable) {
        setPickHint("No folder dialog on this machine — paste the folder path above.");
      } else if (picked.error) {
        setPickHint(`Dialog failed: ${picked.error} — paste the folder path above instead.`);
      } else {
        setPickHint(null);
      }
    } catch (cause) {
      setPickHint(
        `Dialog failed: ${cause instanceof Error ? cause.message : String(cause)} — paste the folder path above instead.`,
      );
    } finally {
      setPicking(false);
    }
  }, []);

  const createProject = useCreateProject();

  const submit = useCallback(() => {
    if (rootPath.trim().length === 0 || createProject.isPending) return;
    setFormError(null);
    // ROUND-33 (owner): the project name IS the folder's name — no manual
    // name picking. Derive from the path's basename (Windows + POSIX safe).
    const sep = /[/\\]/;
    const folderName = rootPath.trim().split(sep).filter(Boolean).pop() ?? "project";
    createProject.mutate(
      { name: folderName, rootPath: rootPath.trim() },
      {
        onSuccess: (project) => {
          onClose();
          onCreated(project.id);
        },
        onError: (error) => {
          setFormError(
            error instanceof ApiError
              ? error.message
              : error instanceof Error
                ? error.message
                : "Failed to create the project.",
          );
        },
      },
    );
  }, [rootPath, createProject, onClose, onCreated]);

  const is = { background: styles.inputBg, borderColor: styles.inputBorder, color: styles.text } as const;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center" style={{ background: "rgba(0,0,0,0.55)" }} onClick={onClose}>
      <div
        className="w-[min(440px,90vw)] rounded-[24px] border-[1.5px] p-5"
        style={{ background: styles.card, borderColor: styles.borderStrong, boxShadow: styles.bentoShadow }}
        onClick={(e) => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-label="Add a new project"
      >
        <h3 className="text-[15px] font-black tracking-tight mb-4" style={{ color: styles.text }}>Add New Project</h3>
        <div className="flex flex-col gap-3.5">
          <div>
            <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-widest" style={{ color: styles.textTertiary }}>Project Folder</label>
            <div className="flex gap-2">
              <input ref={pathRef} value={rootPath} onChange={(e) => setRootPath(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void submit()}
                placeholder="C:\projects\my-app  —  the project takes the folder's name"
                className="h-12 min-w-0 flex-1 rounded-[14px] border-[1.5px] px-4 font-mono text-[12px] outline-none"
                style={is} />
              {isTauri() || !demoData ? (
                <button onClick={() => void handleBrowse()} disabled={picking}
                  className="h-12 shrink-0 flex items-center gap-1.5 rounded-[14px] border-[1.5px] px-3.5 text-[12px] font-bold disabled:opacity-60"
                  style={{ background: styles.subtle, borderColor: styles.border, color: styles.textSecondary }}>
                  <FolderOpen size={13} /> Browse
                </button>
              ) : null}
            </div>
            {pickHint && <p className="mt-1.5 text-[11px]" style={{ color: styles.textTertiary }}>{pickHint}</p>}
          </div>
          {formError && (
            <p role="alert" className="rounded-[12px] border px-3 py-2 text-[12px]"
              style={{ borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.3), background: withAlpha(SEMANTIC_COLORS.danger, 0.08), color: SEMANTIC_COLORS.danger }}>
              {formError}
            </p>
          )}
          <button onClick={() => void submit()}
            disabled={rootPath.trim().length === 0 || createProject.isPending}
            className="h-12 w-full rounded-full font-black text-[14px] tracking-[-0.01em] transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:hover:scale-100"
            style={{ background: styles.accent, color: styles.accentText, border: `1.5px solid ${styles.accent}`, boxShadow: `0 4px 16px ${withAlpha(styles.accent, 0.25)}` }}>
            {createProject.isPending ? "Creating…" : "Create Project"}
          </button>
        </div>
      </div>
    </div>
  );
}
