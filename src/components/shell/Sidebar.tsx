import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
// R102-C: the settings-section list + search keywords come from the ONE
// shared module (settings-sections.ts) — the sidebar's restored SETTINGS
// MODE and the SettingsPage's ?tab= machine render from the same source.
import { SETTINGS_SECTIONS, sectionMatchesQuery } from "../settings/settings-sections";
import { Search } from "lucide-react";
import {
  ArrowLeft,
  BarChart3,
  ChevronDown,
  CircleAlert,
  FolderOpen,
  LayoutDashboard,
  LoaderCircle,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Settings,
  Trash2,
  X,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
// R126 (MOTION.md §2): the disclosure spring — imported, never hand-rolled.
import { DISCLOSURE_SPRING } from "../../lib/motion";
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
// R99-C: the app-wide "an update is pending" signal — drives the accent dot
// on the sidebar's Settings entries (the store persists across restarts and
// self-heals at boot via initUpdateChecker).
import { useUpdateCheckerStore } from "../../lib/update-checker";
import { withAlpha } from "../dashboard/helpers";
import { SkeletonRows } from "../shared/Skeletons";
// R100-F (research §C2 P2): the section headers ride THE one kicker — the
// ui/Kicker primitive (11px/500/uppercase/tracking-[0.08em]/tertiary).
import { Kicker } from "../ui/Kicker";
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

/** R100-F (research §C2 P2): the project's tile — FLAT project color + a 1px
 * border. The ROUND-42 vertical gradient + inner highlight + text-shadow is
 * retired (the "gradient tile" slop pattern — JetBrains new UI deliberately
 * flattens project icons); the tile keeps its color-identity job. R60-C: the
 * `selected` inset-ring variant died with the collapsed rail — the tile is
 * the expanded-row mark only. */
function ProjectTile({
  color,
  name,
  size = 24,
  radius = 8,
  fontSize = 12,
}: {
  color: string;
  name: string;
  size?: number;
  radius?: number;
  fontSize?: number;
}) {
  return (
    <span
      className="shrink-0 grid place-items-center font-semibold text-white select-none"
      style={{
        width: size,
        height: size,
        // R126 (mobile letter-avatar law): the rounded-square identity mark —
        // radius ≈ 33% of size (the mobile 38% read at PC's 24px tier), the
        // FLAT project color (the pre-R126 1px black rim is retired — the
        // tile rides the clay small shadow for its edge, exactly like the
        // mobile's neutral avatar tile).
        borderRadius: radius,
        fontSize,
        background: color,
        boxShadow: "var(--ac-clay-shadow-sm)",
      }}
      aria-hidden
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

/**
 * AcuteLogo (round-33; ROUND-49 redesign; R126 clay identity): the custom app
 * mark — a rounded clay tile with a WHITE CAT-FACE SILHOUETTE (owner round-49:
 * "the logo of our application should be a silhouette of the face of a cat…
 * a proper SVG icon… detailed enough"). The mark: two pointed ears, a gently
 * dipping crown, rounded cheeks tapering to a soft chin, two slanted almond
 * eyes and a small triangular nose punched out of the silhouette (evenodd
 * holes, the tile's gradient shows through) — detailed enough to read as a
 * cat face from 16px (favicon) to 52px (chat empty state) without turning to
 * mud. R60-C: a mark WITH a click handler renders a real <button> (hover
 * morphs the mark into a panel-left icon, click toggles); a DECORATIVE mark
 * renders a <span> — the TitleBar's identity control is a <button> that WRAPS
 * the logo, and interactive content may never nest, so the logo inside it is
 * the non-interactive variant. Used by the title-bar identity control, the
 * mobile drawer trigger, the floating show-sidebar button, the chat empty
 * state, and the connection splash — all through the same `size` prop. The
 * mark mirrors public/favicon.svg 1:1.
 * R126 (the Clay Companion redesign): the tile's identity is the CLAY accent
 * family now — the gradient rides the live --ac-* vars (accent → accentDeep,
 * 155°; the pre-R126 hardcoded orange stops are retired along with their
 * orange-only glow — the shadow is the clay small-step recipe). Theme-aware,
 * audit-clean (zero hardcoded hexes — the count only goes down).
 */
export function AcuteLogo({
  size = 32,
  radius,
  hoverToggle = false,
  onClick,
  ariaLabel,
  title,
}: {
  size?: number;
  /** R100-F: explicit ladder radius (4/8/12/16) — defaults to the brand
   * formula (size × 0.28, the favicon mirror) when unset. */
  radius?: number;
  hoverToggle?: boolean;
  onClick?: () => void;
  ariaLabel?: string;
  title?: string;
}) {
  // R100-F: the hover morph is PURE CSS now (group + group-hover opacity
  // crossfade) — the useState + onMouseEnter/Leave pair is retired
  // (TOKENS §6: hover is a class, never a JS handler).
  // Shared presentation for both element kinds (button when interactive).
  const shared = {
    "aria-label": ariaLabel ?? "Acute",
    title,
    className: "relative group grid place-items-center transition-transform active:scale-95",
    style: {
      width: size,
      height: size,
      borderRadius: radius ?? Math.round(size * 0.28),
      // R126: the clay accent family, 155° — light mode runs terracotta →
      // ember (#C4653F → #B45330); dark mode's collapsed tiers read as a
      // soft salmon tile (the white cat holds 4.5:1 on every stop). CSS
      // vars resolve at paint, so the mark follows the live theme.
      background:
        "linear-gradient(155deg, var(--ac-accent) 0%, var(--ac-accent) 55%, var(--ac-accent-deep) 100%)",
      // R126: the clay small-step shadow (warm ink, never the orange glow).
      boxShadow: "var(--ac-clay-shadow-sm)",
    },
  };
  const mark = (
    <>
      {/* The cat-face silhouette — solid white head with pointed ears; the
          slanted almond eyes + triangular nose are evenodd punch-outs (the
          tile gradient shows through). Fades out on hover when hoverToggle
          (R100-F: the CSS group-hover leg, no JS state). */}
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        aria-hidden
        className={cn(
          "absolute inset-0 transition-opacity",
          hoverToggle && "group-hover:opacity-0",
        )}
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
      {/* The panel-left toggle icon — fades in on hover when hoverToggle
          (R100-F: the CSS group-hover leg, no JS state). */}
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
          className="absolute opacity-0 transition-opacity group-hover:opacity-100"
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
 *   in-sidebar logo + the collapse button + the old collapsed rail are
 *   GONE. The panel is either fully visible (AppShell's appSidebarVisible)
 *   or fully absent — no intermediate state, no COLLAPSE_KEY persistence.
 * - R100-E1 (research §C2 P1(a)): the ROUND-34 "settings mode" is RETIRED —
 *   the settings page now hosts its own nav column + search (the VS Code
 *   pattern), so the sidebar keeps only its ONE "Settings" entry (the
 *   footer button + the rail's gear) pointing at /settings. On /settings
 *   routes the sidebar renders the NORMAL nav — its Dashboard row is the
 *   back affordance the R95-A owner directive assigned to the left sidebar.
 * - GENEROUS spacing between NAVIGATION and PROJECTS (owner: "way too close
 *   together").
 * - PROJECTS: no chevron, no session-count chip; the "+ new session" button
 *   lives ON the project row itself (owner directive); sessions are
 *   renameable (round-33).
 * - FOOTER: a PROMINENT Settings button (card-style, not a plain nav row).
 */
export function Sidebar() {
  const styles = useThemeStyles();
  // ROUND-45 (VLM-pass find): MOBILE DRAWER. Below md the sidebar is a
  // fixed overlay (the old static 270px column left only 69px of content at
  // 375px) — closed by default, opened by the floating logo trigger,
  // closed by the backdrop, and auto-closed on navigation. R60-C: this is
  // the ONLY mobile affordance (mobile has no title bar) — kept exactly.
  const [mobileOpen, setMobileOpen] = useState(false);
  const { pathname, search } = useLocation();

  // R102-C (owner v0.99.0): the ROUND-34 settings mode RESTORED — on
  // /settings the sidebar's whole body becomes the settings nav (back pill
  // + search + the grouped section list) and the settings page renders the
  // content pane alone. The ?tab= param stays the one truth: nav clicks
  // write it, the deep links keep working, the mobile drawer carries the
  // same body below md.
  const isSettingsRoute = pathname.startsWith("/settings");
  const activeSettingsTab = new URLSearchParams(search).get("tab") ?? "appearance";

  // ROUND-45: any navigation closes the mobile drawer (standard drawer UX).
  // R102-C: search is BACK in the deps — the settings-mode body re-renders
  // when ?tab= changes so the active row follows the URL (the R100-E1
  // removal was for the retired mode; the restore needs the watch again).
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  // R60-C: the panel's own visibility is NOT decided here — AppShell's
  // appSidebarVisible (flipped by the TITLE BAR identity control in Tauri,
  // the floating Acute logo in web dev mode) mounts/unmounts this whole
  // component. ROUND-62 (owner: "i should be given the option to minimize
  // it rather than just hiding it completely") adds the SECOND state on
  // top: MINIMIZED — the sidebar becomes its 48px icon rail (R100-F: rail
  // 64→48px, the activity-bar standard — nav icons + project tiles +
  // bell/settings) with the restore button at its very
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
          TitleBar owns the top 40px — drop below it. R100-F: the offsets snap
          to the grid utilities (top-12 under the 40px bar · left-2.5). */}
      {!mobileOpen && (
        <div
          className={`fixed left-2.5 z-50 md:hidden ${
            isTauri() ? "top-12" : "top-2.5"
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
      // ROUND-62: the width is rail-conditional again with a 200ms width
      // transition so minimizing feels alive. R100-F (research §C2 P2):
      // 270→240px full (VS Code's 300 is for trees; ours is nav) · 64→48px
      // rail (the activity-bar standard), both as SCALE utilities; the panel
      // radius snaps 20→16px (rounded-2xl, the card/panel tier).
      initial={{ opacity: 0, x: -14 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
      className={cn(
        // R126 (the Clay Companion redesign): the panel is a RAISED CLAY CARD
        // — the warm rim hairline (1px, all four sides — the 1.5px bento
        // border is retired) + the layered clay shadow (.ac-clay, TOKENS
        // §5/§9). The sidebarBg fill stays (the owner's distinct-surface
        // verdict, R30) — the rim derives from the theme, so every flavor
        // keeps its harmonious tint.
        "ac-clay shrink-0 flex flex-col rounded-2xl border transition-[width] duration-200",
        // R101-C (owner v0.98.0: the minimized rail "was not looking
        // pro-good"): minimized, the panel opens its HORIZONTAL clip so the
        // rail's hover/focus label chips (RailLabel below) can paint past
        // the rail over the content pane — `overflow-x: visible` is
        // preserved when the other axis is `clip` (the one sanctioned axis
        // pair; scroll/auto/hidden would force x to auto and swallow the
        // chips). Vertical overflow stays clipped at the panel edge.
        // Expanded, overflow-hidden stays: it clips the full sidebar's
        // content during the 240↔56 width transition (the rail content is
        // never wider than the animating panel, so nothing spills).
        //
        // R102-B (owner v0.99.0: "the left sidebar apparently looks a little
        // bit squished when it is minimized"): the rail widens 48→56px
        // (w-12→w-14) with 40px buttons + px-2 side insets — the 48px rail's
        // 36px buttons left only 4.5px of breathing room per side (the
        // corners ate into it) and read as cramped. 56/40/8/8 is the roomy
        // activity-bar geometry (VS Code's own ratio).
        minimized ? "w-14 overflow-x-visible overflow-y-clip" : "w-60 overflow-hidden",
        // ROUND-45: below md this is an overlay drawer, not a flex column.
        "max-md:fixed max-md:inset-y-3 max-md:left-3 max-md:z-50",
        mobileOpen ? "max-md:translate-x-0" : "max-md:-translate-x-[120%] max-md:pointer-events-none",
        "max-md:transition-transform max-md:duration-200",
      )}
      aria-label="Main sidebar"
      style={{
        backgroundColor: styles.sidebarBg,
        borderColor: styles.clayRim,
      }}
    >
      {/* R60-C: NO header row — the nav starts at the panel's top (the
          logo + collapse button moved out with the rail). ROUND-62: a slim
          MINIMIZE row returns at the very top (owner: "i should be given
          the option at the very top to minimize it") — one icon button,
          right-aligned so it sits where the sidebar meets the chat (the
          direction it shrinks toward); the rail's restore button is its
          mirror.
          R100-E1 retired the ROUND-34 SETTINGS MODE (the settings page
          owned its own nav column). R102-C RESTORES it (owner v0.99.0:
          "the left sidebar does not change and the settings sidebar shows
          on the right side of the left sidebar … handle it just like how
          it was handled previously") — on /settings the sidebar's whole
          body becomes the settings nav and the settings page is the
          content pane alone (no doubled sidebar). */}
      {minimized ? (
        <MinimizedRail
          onExpand={() => setAppSidebarMinimized(false)}
          variant={isSettingsRoute ? "settings" : "normal"}
          activeSettingsTab={isSettingsRoute ? activeSettingsTab : undefined}
        />
      ) : isSettingsRoute ? (
        <SettingsSidebarBody
          activeTab={activeSettingsTab}
          onMinimize={() => setAppSidebarMinimized(true)}
        />
      ) : (
        <>
          {/* ROUND-62: the MINIMIZE row — the owner's directive ("option at
              the very top to minimize it"). One quiet icon button,
              right-aligned where the panel meets the chat (the direction it
              shrinks toward); its mirror is the rail's expand button.
              R100-F: 28px target, rounded-lg, hover = the CSS wash. */}
          <div className="shrink-0 flex items-center justify-end px-2.5 pt-2.5 pb-0.5">
            <button
              onClick={() => setAppSidebarMinimized(true)}
              aria-label="Minimize sidebar"
              title="Minimize sidebar"
              data-testid="sidebar-minimize"
              className="w-7 h-7 rounded-lg grid place-items-center transition-colors hover:bg-hover"
              style={{ color: styles.textTertiary }}
            >
              <PanelLeftClose size={16} />
            </button>
          </div>

          {/* NAVIGATION SECTION — dedicated section for Dashboard + Usage.
              R100-F: the header rides THE one kicker (ui/Kicker) — the
              10.5px font-black hand-rolled variant is retired. */}
          <div className="shrink-0 flex items-center px-4 pt-3 pb-1.5">
            <Kicker>Navigation</Kicker>
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

          {/* Divider — generous spacing around it (owner round-33).
              R100-F: 1.5→1px hairline (TOKENS §5 — 1.5px is top-level
              bento only; this is an inside-panel line). */}
          {/* R126: the interior divider is the hairline tier (borderSubtle —
              TOKENS §1a); the panel's own rim carries the visible edge. */}
          <div className="shrink-0 mx-3 my-4 border-t" style={{ borderColor: styles.borderSubtle }} />

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
            style={{ borderColor: styles.borderSubtle }}
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
 * just hiding it completely") — the sidebar's MINIMIZED icon rail: a 48px
 * column (R100-F: 64→48px, the activity-bar standard) with the restore
 * button at the very top, then Dashboard/Usage, the
 * project tiles (click → that project's chat; the running dot carries the
 * live-work signal), a +N overflow tile when the 10-tile cap cuts the list
 * (R101-C), a flexible spacer, and the collapsed bell + settings
 * gear at the bottom. Every button keeps its `title` tooltip AND carries a
 * styled hover/focus label chip (R101-C's RailLabel) so the rail stays fully
 * usable without permanent labels. The mobile drawer reuses the same rail
 * body (a narrow drawer of icons is still perfectly navigable).
 */
// R99-C: the update-pending dot shared by every "Settings" entry point —
// the full sidebar's SettingsButton and the rail's settings gear. The DOT
// mirrors the project tile's running-dot grammar (10px accent pill on a
// sidebar-bg ring); aria-hidden + an sr-only "update available" carries the
// meaning to screen readers without inventing a new chip species.
function UpdatePendingDot({ styles }: { styles: ReturnType<typeof useThemeStyles> }) {
  const updatePending = useUpdateCheckerStore((s) => s.pendingVersion !== null);
  if (!updatePending) return null;
  return (
    <>
      <span
        aria-hidden
        data-testid="settings-update-dot"
        className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2"
        style={{ background: styles.accent, borderColor: styles.sidebarBg }}
      />
      <span className="sr-only">update available</span>
    </>
  );
}

/**
 * R101-C (owner v0.98.0: "when the sidebar was minimized, it was apparently
 * not handled properly. It was not looking pro-good"): the minimized
 * rail's styled hover/focus LABEL CHIP. The rail previously carried its
 * labels ONLY as native `title` tooltips — no styled affordance, and the
 * bare 48px column read as unstructured. Every rail button (the `group`)
 * now renders this chip beside it: a rounded-lg label on the panel's own
 * surface tokens that fades in on CSS `group-hover` and on keyboard focus
 * (`group-focus-visible`; `group-focus-within` covers the wrapped
 * NotificationBell, whose focusable button is a DOM child of its group
 * wrapper) — TOKENS §6: hover is a class, never a JS handler. The chip
 * duplicates its button's aria-label, so it is aria-hidden; the native
 * title stays (it costs nothing).
 */
function RailLabel({
  text,
  styles,
}: {
  text: string;
  styles: ReturnType<typeof useThemeStyles>;
}) {
  return (
    <span
      aria-hidden
      data-testid="rail-label"
      // R126: the label chip is a rising clay surface — card fill + the
      // warm rim + the UPWARD shadow leg (.ac-clay-sheet, MOTION §4: docks
      // and anything that rises cast their shadow up).
      className="ac-clay-sheet pointer-events-none absolute left-full top-1/2 z-50 ml-2.5 -translate-y-1/2 whitespace-nowrap rounded-lg border px-2.5 py-1.5 text-[12px] font-medium opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100 group-focus-within:opacity-100"
      style={{ background: styles.card, borderColor: styles.clayRim, color: styles.text }}
    >
      {text}
    </span>
  );
}

/** R102-C: the sidebar's SETTINGS-MODE body (the ROUND-34 design restored —
 * owner v0.99.0: "handle it just like how it was handled previously").
 * On /settings the sidebar's whole body becomes the settings nav:
 *  - the top row: the R95-A labeled "← Dashboard" back pill (the ONE back
 *    affordance outside the rail) + the minimize button at the row's end;
 *  - the search box (R100-E1's VS Code settings-search pattern, moved HERE
 *    from the retired settings-local nav column — filters the section list
 *    by label + the shared SEARCH_KEYWORDS, never touches the ?tab=
 *    machine);
 *  - the grouped section list (one Kicker between category clusters, the
 *    NavButton row grammar: 32px rows, active = accent text + soft bg +
 *    the 2px leading accent bar) — the About row carries the update dot.
 * The ?tab= param stays the single source of truth: every row navigates
 * to /settings?tab=<id> (same param the deep links have always used).
 */
function SettingsSidebarBody({
  activeTab,
  onMinimize,
}: {
  activeTab: string;
  onMinimize: () => void;
}) {
  const styles = useThemeStyles();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const visibleSections = SETTINGS_SECTIONS.filter((s) => sectionMatchesQuery(s, needle));

  return (
    <>
      {/* The top row — the R95-A back pill + the minimize control (the
          normal mode's minimize row's exact mirror). */}
      <div className="shrink-0 flex items-center gap-1.5 px-2.5 pt-2.5 pb-1">
        <button
          onClick={() => navigate("/")}
          aria-label="Back to dashboard"
          title="Back to dashboard"
          data-testid="sidebar-back-dashboard"
          className="h-8 shrink-0 inline-flex items-center gap-1.5 px-3 rounded-full border-[1.5px] text-[12px] font-semibold transition-colors hover:bg-hover"
          style={{ borderColor: styles.sidebarBorder, color: styles.textSecondary }}
        >
          <ArrowLeft size={13} /> Dashboard
        </button>
        <span className="text-[13px] font-semibold tracking-tight truncate" style={{ color: styles.text }}>
          Settings
        </span>
        <button
          onClick={onMinimize}
          aria-label="Minimize sidebar"
          title="Minimize sidebar"
          data-testid="sidebar-minimize"
          className="w-7 h-7 ml-auto shrink-0 rounded-lg grid place-items-center transition-colors hover:bg-hover"
          style={{ color: styles.textTertiary }}
        >
          <PanelLeftClose size={16} />
        </button>
      </div>

      {/* The search box (R100-E1's pattern, R102-C's home): 12px text, 28px
          height, rounded-lg; focus = the GLOBAL :focus-visible rule — no
          local focus: classes (the R100-D scoping discipline). */}
      <div className="shrink-0 px-2.5 pt-1.5 pb-2">
        <div className="relative">
          <Search
            size={12}
            aria-hidden
            className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
            style={{ color: styles.textTertiary }}
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search settings"
            aria-label="Search settings"
            data-testid="settings-nav-search"
            className="h-7 w-full rounded-lg border border-line bg-input pl-7 pr-2.5 text-[12px] text-ink placeholder:text-muted"
          />
        </div>
      </div>

      {/* The grouped section list — the NavButton row grammar. */}
      <nav
        className="flex-1 min-h-0 flex flex-col gap-0.5 px-2.5 pb-3 pt-1 overflow-y-auto"
        aria-label="Settings sections"
      >
        {visibleSections.map((section, index) => {
          const { id, label, icon: Icon } = section;
          const active = id === activeTab;
          const groupHeader =
            index === 0 || section.group !== visibleSections[index - 1].group
              ? section.group
              : undefined;
          return (
            <Fragment key={id}>
              {groupHeader !== undefined && (
                <Kicker testId={`settings-group-${groupHeader}`} className="px-2 pb-1 pt-3 first:pt-0">
                  {groupHeader}
                </Kicker>
              )}
              <button
                onClick={() => navigate(`/settings?tab=${id}`)}
                aria-current={active ? "page" : undefined}
                data-testid={`settings-nav-${id}`}
                className={cn(
                  "relative flex h-8 items-center gap-2.5 rounded-lg px-3 text-[13px] transition-colors",
                  active
                    ? "bg-accent-tint font-medium text-accent-deep"
                    : "font-normal text-muted hover:bg-hover",
                )}
              >
                {/* Selection grammar (R126, TOKENS §1d/§10): the accent TINT
                    container + deep accent ink + the 2px accentDeep bar. */}
                {active ? (
                  <span aria-hidden className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-accent-deep" />
                ) : null}
                <Icon size={16} strokeWidth={2} className="shrink-0" aria-hidden />
                <span className="truncate">{label}</span>
                {/* R99-C: the update-pending dot rides the ABOUT row (the
                    update check lives there; the normal sidebar's Settings
                    button carries the same dot). */}
                {id === "about" && <UpdatePendingDot styles={styles} />}
              </button>
            </Fragment>
          );
        })}
        {needle !== "" && visibleSections.length === 0 ? (
          <p data-testid="settings-nav-empty" className="px-2 py-3 text-[12px]" style={{ color: styles.textTertiary }}>
            No settings match
          </p>
        ) : null}
      </nav>
    </>
  );
}

function MinimizedRail({
  onExpand,
  variant = "normal",
  activeSettingsTab,
}: {
  onExpand: () => void;
  /** R102-C: the rail's settings variant (R66's behavior restored) — on
   * /settings the rail renders back-to-dashboard + the section icons,
   * never the projects tiles (minimizing a settings page must not teleport
   * the owner into the projects world). */
  variant?: "normal" | "settings";
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
    showUpdateDot = false,
  ) => (
    <button
      onClick={onClick}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      title={label}
      data-testid={testId}
      // R100-F: the rail's buttons (≥28px targets); active = the
      // soft-accent selection grammar (the solid accent fill + accent glow
      // is retired); hover = the CSS wash — no JS handlers.
      // R101-C: `group` hosts the button's hover/focus LABEL CHIP (RailLabel),
      // and the ACTIVE button gains the same 2px leading accent bar the
      // expanded NavButton carries — the rail's selection grammar mirrors
      // the full panel's.
      // R102-B (owner v0.99.0: the minimized rail "looks a little bit
      // squished"): 36→40px buttons (w-10 h-10) in the 56px rail — the
      // geometry change that answers the squish (see the aside's comment).
      className={cn(
        "group relative w-10 h-10 shrink-0 grid place-items-center rounded-lg transition-colors",
        active ? "bg-accent-tint text-accent-deep" : "text-muted hover:bg-hover",
      )}
    >
      {active ? (
        <span aria-hidden className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-accent-deep" />
      ) : null}
      {icon}
      <RailLabel text={label} styles={styles} />
      {/* R99-C: the update-pending dot on the rail's SETTINGS entry (the
          full sidebar's SettingsButton carries the same dot). */}
      {showUpdateDot && <UpdatePendingDot styles={styles} />}
    </button>
  );

  return (
    <div
      // R101-C: the rail body no longer scrolls (overflow-y-auto dropped):
      // a scroll container clips on BOTH axes (visible x computes to auto),
      // which would swallow the RailLabel chips — the point of this round.
      // The 10-project cap + the +N overflow tile below bound the rail's
      // height, and the aside's overflow-y-clip cuts anything past the
      // panel edge, so the rail keeps its visual integrity on short windows.
      // R102-B: px-1.5→px-2 — the 56px rail's 40px buttons get 8px of
      // breathing room per side (the squish fix's body-side half).
      className="flex-1 min-h-0 flex flex-col items-center gap-1.5 px-2 pt-2.5 pb-2.5"
      data-testid="sidebar-rail"
    >
      {/* RESTORE — at the rail's very top (the minimize button's mirror).
          R100-F: rounded-lg on the CSS-var leg (bg-input + the hover wash
          class — the JS hover pair is retired).
          R101-C: carries the rail's hover/focus label chip like every other
          rail button. R102-B: 40px (the squish fix). */}
      <button
        onClick={onExpand}
        aria-label="Expand sidebar"
        title="Expand sidebar"
        data-testid="sidebar-expand"
        className="group relative w-10 h-10 shrink-0 grid place-items-center rounded-lg bg-input transition-colors hover:bg-hover"
        style={{ color: styles.textTertiary }}
      >
        <PanelLeftOpen size={16} />
        <RailLabel text="Expand sidebar" styles={styles} />
      </button>

      {/* R102-C: the rail's SETTINGS VARIANT (R66's behavior restored) —
          back-to-dashboard + the section icons, NEVER the projects tiles
          (minimizing a settings page must not teleport the owner into the
          projects world — his R66 report: "it shows me the wrong sidebar").
          Flat, no group headers (the grouped nav is the expanded panel's
          job); every icon carries the R101-C label chip + the active
          selection grammar; the About icon carries the update dot. */}
      {variant === "settings" ? (
        <>
          {railBtn(
            "Back to dashboard",
            <ArrowLeft size={16} strokeWidth={2} />,
            false,
            () => navigate("/"),
            "rail-back-dashboard",
          )}
          <div className="w-9 shrink-0 border-t my-1" style={{ borderColor: styles.borderSubtle }} />
          {SETTINGS_SECTIONS.map(({ id, label, icon: Icon }) =>
            railBtn(
              label,
              <Icon size={16} strokeWidth={2} />,
              activeSettingsTab === id,
              () => navigate(`/settings?tab=${id}`),
              `rail-settings-${id}`,
              id === "about",
            ),
          )}
          {/* Spacer + the collapsed bell — footer parity with the normal
              rail (notifications stay reachable while browsing settings). */}
          <div className="flex-1 min-h-2" />
          <div className="group relative shrink-0">
            <NotificationBell collapsed />
            <RailLabel text="Notifications" styles={styles} />
          </div>
        </>
      ) : (
        <>
          {railBtn("Dashboard", <LayoutDashboard size={16} strokeWidth={2} />, pathname === "/", () => navigate("/"), "rail-dashboard")}
          {railBtn("Usage", <BarChart3 size={16} strokeWidth={2} />, pathname.startsWith("/usage"), () => navigate("/usage"), "rail-usage")}

          {/* Hairline divider (the full sidebar's section divider, rail-sized).
              R100-F: 1.5→1px hairline. R102-B: w-8→w-9 (the 56px rail's
              proportion). */}
          <div className="w-9 shrink-0 border-t my-1" style={{ borderColor: styles.borderSubtle }} />

      {/* PROJECT TILES — click opens the project's chat; the tile is the
          project's own color mark (ProjectTile), so color identity
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
             tiles in the real tile button's exact geometry (R102-B:
             w-10 h-10, the 56px rail's 40px buttons, rounded-lg), never a
             blank rail
             that reads as "no projects". Decorative on purpose: the rail
             stays quiet; the expanded sidebar owns the one role=status
             announcement. On ERROR the rail renders nothing extra — the full
             sidebar owns the retryable error surface. */
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
                // R100-F: rounded-lg; the active tint follows the
                // project's own color (dynamic — the JS leg); hover = the
                // CSS wash (no JS handlers); the border drops 1.5→1px.
                // R102-B: 36→40px (the 56px rail's squish fix).
                // R101-C: `group` hosts the FULL-NAME label chip — the
                // project's identity survives minimization with an actual
                // styled affordance, not just a native title tooltip.
                className="group relative w-10 h-10 shrink-0 grid place-items-center rounded-lg transition-colors hover:bg-hover"
                style={{
                  background: active ? withAlpha(project.color, 0.14) : undefined,
                  border: active ? `1px solid ${withAlpha(project.color, 0.4)}` : "1px solid transparent",
                }}
              >
                <ProjectTile color={project.color} name={project.name} />
                <RailLabel text={project.name} styles={styles} />
                {running && (
                  <span
                    aria-label="Running"
                    className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2"
                    style={{ background: styles.accent, borderColor: styles.sidebarBg }}
                  />
                )}
              </button>
            );
          })
        )}
        {/* R101-C (owner v0.98.0): the rail's projects cap at 10 tiles — the
            cut now has an AFFORDANCE instead of a silent disappearance: a
            +N tile in the rail's own button geometry whose click EXPANDS the
            sidebar (the R87-A1 expand-first pattern at the tiles above —
            expanding WITHOUT navigating is the honest behavior; the full
            projects list lives in the expanded panel). */}
        {projects.length > 10 && (
          <button
            onClick={onExpand}
            aria-label={`${projects.length - 10} more projects — expand to see all`}
            title={`${projects.length - 10} more projects — expand to see all`}
            data-testid="rail-projects-overflow"
            className="group relative w-10 h-10 shrink-0 grid place-items-center rounded-lg text-[11px] font-medium tabular-nums text-muted transition-colors hover:bg-hover"
          >
            +{projects.length - 10}
            <RailLabel
              text={`${projects.length - 10} more projects — expand to see all`}
              styles={styles}
            />
          </button>
        )}
      </div>

      {/* Spacer pushes the footer icons to the bottom (the full sidebar's
          footer rhythm). */}
      <div className="flex-1 min-h-2" />

      {/* FOOTER — collapsed bell + settings gear (the rail's one "Settings"
          entry — R102-C: it navigates to /settings, where the rail's
          SETTINGS VARIANT above takes over).
          R101-C: the bell keeps its own button (badge + popover); the group
          WRAPPER hosts its label chip — the chip's group-focus-within leg
          covers the bell's keyboard focus through the wrapper. */}
      <div className="group relative shrink-0">
        <NotificationBell collapsed />
        <RailLabel text="Notifications" styles={styles} />
      </div>
      {railBtn("Settings", <Settings size={16} strokeWidth={2} />, settingsActive, () => navigate("/settings"), "rail-settings", true)}
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
  // R100-F (research §C2 P2): 40→32px row (the row table), 13px/400 label
  // (500 + accent when active). R126 (the Clay Companion selection
  // grammar — TOKENS §1d/§10, mobile "2px when selected, ALWAYS"): the
  // active row carries the accent TINT container (bg-accent-tint) + the
  // DEEP accent ink (text-accent-deep — the tier that holds AA as text) +
  // the 2px accentDeep marker bar. Hover stays the CSS wash; the JS
  // handlers stay gone.
  return (
    <button
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex h-8 items-center gap-2.5 rounded-lg px-3 text-[13px] transition-colors",
        active
          ? "bg-accent-tint font-medium text-accent-deep"
          : "font-normal text-muted hover:bg-hover",
      )}
    >
      {active ? (
        <span aria-hidden className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-accent-deep" />
      ) : null}
      <Icon size={16} strokeWidth={2} className="shrink-0" aria-hidden />
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
 * in an accent-tinted square + label — visually distinct from the plain
 * nav rows above the divider. R60-C: expanded card only (the collapsed gear
 * tile went with the rail). R99-C: carries the update-pending DOT while a
 * newer release is waiting (the rail's settings gear mirrors it).
 * R100-F: 44→32px (the row table), rounded-lg, 13px/400 (500 when active),
 * hover = the CSS border-strong + bg wash (the lift + softShadow hover pair
 * is retired — resting UI never fidgets).
 */
function SettingsButton() {
  const styles = useThemeStyles();
  const navigate = useNavigate();
  const active = useLocation().pathname.startsWith("/settings");
  return (
    <button
      onClick={() => navigate("/settings")}
      aria-current={active ? "page" : undefined}
      className={cn(
        // R126 (the Clay Companion redesign): the prominent Settings card —
        // the clay card treatment (warm rim hairline, the 1.5px bento border
        // retired) + the clay small shadow; the icon tile rides the accent
        // TINT (the ClayIconChip recipe — hue without loudness).
        "relative w-full h-8 flex items-center gap-2.5 px-2.5 rounded-lg border transition-colors",
        active
          ? "bg-accent-tint"
          : "bg-card hover:bg-hover hover:border-[color:var(--ac-border-strong)]",
      )}
      style={{ borderColor: active ? withAlpha(styles.accent, 0.4) : styles.clayRim, boxShadow: "var(--ac-clay-shadow-sm)" }}
    >
      {/* R126: the icon tile = the mobile ClayIconChip recipe — accentTint
          fill + the deep accent glyph. */}
      <span
        className="w-7 h-7 rounded-lg grid place-items-center shrink-0 bg-accent-tint text-accent-deep"
      >
        <Settings size={14} />
      </span>
      <span className={cn("text-[13px] font-normal text-ink", active && "font-medium text-accent-deep")}>
        Settings
      </span>
      {/* R99-C: the update-pending dot (see UpdatePendingDot above). */}
      <UpdatePendingDot styles={styles} />
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
      {/* R100-F: the header rides THE one kicker (ui/Kicker) + the
          meta-mono count chip (10px floor, 500) + a 28px Add button on the
          accent-soft leg (the ROUND-42 black-cap + scale hover is retired). */}
      <div className="flex items-center justify-between px-4 pb-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <Kicker>Projects</Kicker>
          {projects.length > 0 ? (
            // R126: the count chip = the neutral badge tone (TOKENS §11 —
            // the well fill + the clay rim hairline + the secondary ink).
            <span
              className="text-[10px] font-mono font-medium px-1.5 py-0.5 rounded-full tabular-nums border"
              style={{ color: styles.textSecondary, background: styles.surfaceWell, borderColor: styles.clayRim }}
            >
              {projects.length}
            </span>
          ) : null}
        </div>
        <button
          onClick={() => setShowAddDialog(true)}
          title="Add project"
          aria-label="Add project"
          // R100-F: a ≥28px target on the CSS-var leg. R126: the accent TINT
          // container + the DEEP glyph (the ClayIconChip recipe) — hover
          // deepens the tint, never a fidget.
          className="w-7 h-7 grid place-items-center rounded-lg bg-accent-tint text-accent-deep transition-colors hover:bg-accent-faded"
        >
          <Plus size={14} strokeWidth={2.5} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2.5 pb-2 space-y-0.5" style={{ scrollbarWidth: "thin" }}>
        {/* R97-I part 2 (owner: a UI "aware of its states") — LOADING: 4
            skeleton rows in the real ProjectRow's exact geometry (R100-F:
            h-[30px], the list's space-y-0.5 rhythm) hold the
            section open while the query is in flight. Pre-R97 this area
            flashed the FALSE "Add your first project" on every first paint. */}
        {projectsQuery.isPending && (
          <div role="status" aria-label="Loading projects" data-projects-skeleton>
            <SkeletonRows rows={4} rowClassName="h-[30px]" gap={0.5} />
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
            // R100-F: rounded-lg + the 1px hairline; 11.5→12px; the weight
            // law (600 error titles, 600 buttons).
            className="h-10 flex items-center justify-between gap-2 rounded-lg border px-3"
            style={{
              borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.35),
              background: withAlpha(SEMANTIC_COLORS.danger, styles.isDark ? 0.08 : 0.05),
            }}
          >
            <span className="text-[12px] font-semibold truncate" style={{ color: SEMANTIC_COLORS.danger }}>
              Projects failed to load
            </span>
            <button
              type="button"
              onClick={() => {
                void projectsQuery.refetch();
                void sessionsQuery.refetch();
              }}
              aria-label="Retry loading projects"
              className="shrink-0 h-7 px-2.5 rounded-lg text-[11px] font-semibold border transition-opacity hover:opacity-85"
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
            className="px-2 py-1.5 text-[11px]"
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
              {/* Project row — R126 (SCREENS.md §2 law #2, the navigation
                  decision): the row body NAVIGATES into the project's chat
                  (the pre-R126 body only toggled expansion — entering a
                  project required hunting a session row), and a dedicated
                  chevron hit area toggles the session tree. The + button
                  starts a new session directly (owner round-33). ROUND-42:
                  the running animation lives HERE when collapsed. */}
              <ProjectRow
                project={project}
                active={isActive}
                expanded={isExpanded}
                running={runningProjects.has(project.id)}
                onToggle={() => toggleProject(project.id)}
                onOpen={() => navigate(`/project/${project.id}/chat`)}
                onNewSession={() => void createSessionFor(project.id, project.name)}
              />
              {/* Sessions underneath */}
              <AnimatePresence initial={false}>
                {isExpanded && (
                  <motion.div
                    // R126 (MOTION §4, the disclosure grammar): expand rides
                    // the DISCLOSURE spring (one soft settle, {180, 24} —
                    // imported, never hand-rolled); collapse is a TIMING
                    // (200ms) so closing never bounces (the mobile R118-C
                    // law). The opacity fade rides both legs.
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0, transition: { duration: 0.2, ease: [0.25, 0.1, 0.25, 1] } }}
                    transition={DISCLOSURE_SPRING}
                    className="overflow-hidden"
                  >
                    {/* R126 (the Clay Companion redesign, mobile session-list
                        law): the sessions render in ONE RECESSED WELL — the
                        tree rail + per-row bordered cards (the R43 spelling)
                        retire in favor of bg-well + hairline dividers between
                        rows (the differentiation the owner's R43 verdict
                        asked for, one spelling calmer). The well nests under
                        the project row's tile column; rows are flat, the
                        ACTIVE row pops with the accent tint + the 2px
                        accentDeep bar. */}
                    <div
                      data-session-well
                      className="ml-[13px] mr-1 my-1 rounded-lg border bg-well py-1"
                      style={{ borderColor: styles.clayRim }}
                    >
                      {projSessions.slice(0, 8).map((session, i) => (
                        <Fragment key={session.id}>
                          {i > 0 && (
                            <div
                              aria-hidden
                              className="mx-2 border-t"
                              style={{ borderColor: styles.borderSubtle }}
                            />
                          )}
                          <SessionRow
                            session={session}
                            projectId={project.id}
                            active={session.id === activeSessionId}
                          />
                        </Fragment>
                      ))}
                      {projSessions.length > 8 && (
                        <button
                          onClick={() => navigate(`/project/${project.id}`)}
                          className="block w-full px-2 py-1 text-left text-[10px] tabular-nums transition-colors hover:bg-hover"
                          style={{ color: styles.textTertiary }}
                          aria-label={`Show all ${projSessions.length} sessions of ${project.name}`}
                        >
                          +{projSessions.length - 8} more
                        </button>
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
            // R100-F: rounded-lg + the CSS hover wash (the -translate-y-px
            // lift is retired — MOTION.md §4: list-row hover = a wash, no
            // movement); 500 weight, the border on the utility leg.
            className="h-10 w-full flex items-center justify-center gap-2 rounded-lg border border-dashed border-line text-[12px] font-medium transition-colors hover:bg-hover"
            style={{ background: "transparent", color: styles.textTertiary }}
          >
            <Plus size={14} strokeWidth={2.5} />
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
  project, active, expanded, running, onToggle, onOpen, onNewSession,
}: {
  project: Project;
  active: boolean;
  expanded: boolean;
  /** ROUND-42: any session of this project has a turn in flight — the
   * activity animation moves onto the project row itself (owner: "if the
   * session is going on and I collapse the project, the animation should
   * move on to the project itself"). */
  running: boolean;
  /** R126 (SCREENS.md §2 law #2): the row body's destination — the
   * project's chat. The chevron owns the tree toggle. */
  onToggle: () => void;
  onOpen: () => void;
  onNewSession: () => void;
}) {
  const styles = useThemeStyles();

  return (
    <div
      // R100-F (research §C2 P2): 44→30px (the row table), rounded-lg, the
      // flat 24px tile, a 12px/400 label (500 + ink when active). Hover =
      // the CSS wash + group-hover action reveal — the JS hovered state is
      // retired (TOKENS §6); the border drops 1.5→1px.
      // R126: the row is a NAVIGATION row (SCREENS.md §2 law #2) — the
      // body opens the project's chat; the CHEVRON button toggles the
      // session tree (hover-revealed, rotating with the expand state). The
      // round-33 "no chevron" verdict was about RESTING noise — a
      // hover-revealed affordance keeps the clean rest while making the
      // toggle explicit (the explorer-class row/chevron split every modern
      // file navigator uses).
      className="group relative h-[30px] flex items-center gap-2 rounded-lg px-2 cursor-pointer transition-colors hover:bg-hover"
      style={{
        // ROUND-48 (R48-a): the active highlight follows the PROJECT'S OWN
        // color (withAlpha tint), not the theme accent — with per-project
        // palette colors the whole row now reads as belonging to that
        // project (owner: "projects should be given different colors").
        border: active ? `1px solid ${withAlpha(project.color, 0.4)}` : "1px solid transparent",
        background: active ? withAlpha(project.color, 0.1) : undefined,
      }}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter") onOpen(); }}
      aria-label={`Open ${project.name}${running ? " (working)" : ""}`}
    >
      {/* R126: the tree toggle — its own button with its own aria-expanded,
          hover-revealed exactly like the + new-session action beside it. */}
      <button
        onClick={(e) => { e.stopPropagation(); onToggle(); }}
        aria-label={`${expanded ? "Collapse" : "Expand"} ${project.name} sessions`}
        title={`${expanded ? "Collapse" : "Expand"} sessions`}
        aria-expanded={expanded}
        data-testid={`project-toggle-${project.id}`}
        className="relative z-20 w-6 h-6 grid place-items-center rounded-lg transition-opacity duration-150 hover:bg-hover"
        style={{ color: styles.textTertiary }}
      >
        <span className="grid place-items-center transition-transform duration-200" style={{ transform: expanded ? "rotate(0deg)" : "rotate(-90deg)" }}>
          <ChevronDown size={12} />
        </span>
      </button>
      {/* R100-F: the flat tile (see ProjectTile) — the ROUND-42 gradient
          decoration is retired. */}
      <ProjectTile color={project.color} name={project.name} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span
          className={cn("text-[12px] font-normal text-muted truncate", active && "font-medium text-ink")}
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
          itself; no chevron, no session count. R100-F: a ≥28px target,
          rounded-lg, revealed by the CSS group-hover (no JS state, no
          scale fidget). */}
      <button
        onClick={(e) => { e.stopPropagation(); onNewSession(); }}
        aria-label={`Start new session in ${project.name}`}
        title="New session"
        className="relative z-20 w-7 h-7 grid place-items-center rounded-lg bg-accent-tint text-accent-deep opacity-0 transition-opacity group-hover:opacity-100"
      >
        <Plus size={14} strokeWidth={2.5} />
      </button>
      <DeleteProjectButton projectId={project.id} projectName={project.name} />
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
 * and handled better”). Every row is its own bordered card — hairline
 * neutral border at rest, stronger on hover, accent-tinted when ACTIVE.
 * R100-F (research §C2 P2): the 26px-row density snap (the row table) +
 * the ROUND-43 decorative inner-shadow/inset-highlight depth pass is
 * RETIRED (flat working rows — the same flattening the ProjectTile got);
 * hover is the CSS wash + group-hover action reveal (no JS state), the
 * active bar is the E1 selection grammar (2px accent bar), the label is
 * 11px/400 (500 + ink when active — the 700 inline weight is gone), and
 * the border is the 1px hairline everywhere.
 * The leading icon stays STATE-AWARE: spinner while a turn
 * is in flight, chat bubble at rest, alert glyph on failed/cancelled
 * sessions. The R38 pixel-stream on the right is preserved and composes
 * with the running icon (rail-side flourish + at-a-glance state).
 * ACTIVE session (matching the ?session= URL param) keeps the accent tint,
 * 500-weight text + the indicator bar. Hover reveals RENAME (round-33) and
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
          // R100-F: rounded-sm (the 4px step) + the 1px hairline; focus =
          // the GLOBAL :focus-visible rule (the outline-none that beat it
          // is gone).
          className="flex-1 min-w-0 h-6 px-2 rounded-sm border text-[11px]"
          style={{
            background: styles.card,
            borderColor: withAlpha(styles.accent, 0.5),
            color: styles.text,
          }}
        />
        <button
          onClick={() => setEditing(false)}
          aria-label="Cancel rename"
          className="w-6 h-6 grid place-items-center rounded-lg shrink-0 transition-colors hover:bg-hover"
          style={{ color: styles.textTertiary }}
        >
          <X size={12} />
        </button>
      </div>
    );
  }

  return (
    <div
      data-session-row
      data-state={state}
      data-active={active ? "true" : "false"}
      // R126 (the Clay Companion redesign): the row is a FLAT row inside the
      // session WELL (the tree container owns the recess + the dividers —
      // the per-row border/boxShadow of the R43 spelling retired with it;
      // the differentiation contract moves to the well's dividers). ACTIVE
      // = the accent TINT container + the 2px accentDeep marker (the
      // selection grammar); FAILED = the danger wash; hover = the CSS wash.
      // The `border` class stays (transparent at rest) so the geometry of
      // the pinned selection tints never shifts.
      className={cn(
        "group relative flex items-center gap-0.5 rounded-lg pl-0.5 pr-1 border transition-colors",
        active
          ? "bg-accent-tint"
          : state === "failed"
            ? "border-transparent bg-[color-mix(in_srgb,var(--ac-danger)_5%,transparent)] hover:bg-[color-mix(in_srgb,var(--ac-danger)_8%,transparent)]"
            : "border-transparent hover:bg-hover",
      )}
      style={{
        borderColor: active
          ? withAlpha(styles.accent, 0.45)
          : state === "failed"
            ? withAlpha(SEMANTIC_COLORS.danger, 0.35)
            : "transparent",
      }}
    >
      {/* Active indicator bar — the 2px accentDeep marker (R126 selection
          grammar — "2px when selected, ALWAYS", the mobile law). */}
      <span
        className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-accent-deep transition-opacity"
        style={{ opacity: active ? 1 : 0 }}
        aria-hidden
      />
      <button
        onClick={() => navigate(`/project/${projectId}/chat?session=${session.id}`)}
        aria-current={active ? "true" : undefined}
        className={cn(
          "flex-1 min-w-0 h-[26px] flex items-center gap-2 px-2 text-[11px] font-normal text-muted truncate",
          active && "font-medium text-ink",
        )}
        // R126: the label weight law stands; the ACTIVE tint rides the row.
        title={session.title ?? "Untitled"}
      >
        {/* ROUND-43 state-aware icon: running → spinner, failed → alert,
            idle → chat bubble. R100-F: 12px (the row-icon tier). */}
        {state === "running" ? (
          <LoaderCircle
            size={12}
            className="shrink-0 animate-spin text-accent"
            aria-label="Session is working"
          />
        ) : state === "failed" ? (
          <CircleAlert
            size={12}
            className="shrink-0 text-[color:var(--ac-danger)]"
            aria-label="Session failed"
          />
        ) : (
          <MessageSquare
            size={12}
            className="shrink-0"
            // R126: the active glyph rides the DEEP accent (accent-as-text
            // tier — TOKENS §1d), never the marker hue.
            style={{ color: active ? styles.accentDeep : styles.textTertiary }}
          />
        )}
        <span className="truncate">{session.title ?? "Untitled"}</span>
      </button>
      {/* Rename (round-33) — revealed by the CSS group-hover (R100-F: the
          JS opacity state + the fixed black/10 overlay are retired for the
          theme-correct hover wash). */}
      <button
        onClick={(e) => { e.stopPropagation(); setDraft(session.title ?? ""); setEditing(true); }}
        aria-label={`Rename session ${session.title ?? "Untitled"}`}
        title="Rename session"
        className="relative z-10 w-6 h-6 grid place-items-center rounded-lg transition-opacity duration-150 opacity-0 group-hover:opacity-100 hover:bg-hover"
        style={{ color: styles.textTertiary }}
      >
        <Pencil size={12} />
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); remove(); }}
        disabled={deleteSession.isPending}
        aria-label={`Delete session ${session.title ?? "Untitled"}`}
        title="Delete session"
        className="relative z-10 w-6 h-6 grid place-items-center rounded-lg transition-opacity duration-150 opacity-0 group-hover:opacity-100 hover:bg-hover"
        style={{ color: styles.textTertiary }}
      >
        <Trash2 size={12} />
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
  projectId, projectName,
}: {
  projectId: string; projectName: string;
}) {
  const styles = useThemeStyles();
  const { remove } = useDeleteProjectSimple();
  return (
    <button
      onClick={(e) => { e.stopPropagation(); remove(projectId); }}
      aria-label={`Delete ${projectName}`}
      title={`Delete ${projectName}`}
      // R100-F: revealed by the CSS group-hover (the `visible` prop + the
      // parent's JS hovered state are retired); rounded-lg + the hover wash.
      className="relative z-20 w-6 h-6 grid place-items-center rounded-lg transition-opacity opacity-0 group-hover:opacity-100 hover:bg-hover"
      style={{ color: styles.textTertiary }}
    >
      <Trash2 size={12} />
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
        // R100-F: the ladder sweep — dialog radius 24→12px (rounded-xl, the
        // dialogs tier of TOKENS §4), the section-tier heading (13px/600 —
        // the 15px font-black is retired), the kicker-tier form label, the
        // rounded-lg 40px input + Browse (1px hairlines). R126 (the Clay
        // Companion redesign): the card rides the clay material — the warm
        // rim hairline (the 1.5px bento border retired) + the layered clay
        // shadow; the CTA is the QUIET-SOLID clay primary (accentDeep fill +
        // accentText ink — COMPONENTS §4) with NO glow and NO hover-scale;
        // hover = opacity only, the universal press stays.
        className="ac-clay w-[min(440px,90vw)] rounded-xl border p-5"
        style={{ background: styles.card, borderColor: styles.clayRim }}
        onClick={(e) => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-label="Add a new project"
      >
        <h3 className="text-[13px] font-semibold mb-4" style={{ color: styles.text }}>Add New Project</h3>
        <div className="flex flex-col gap-3.5">
          <div>
            <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-[0.08em]" style={{ color: styles.textTertiary }}>Project Folder</label>
            <div className="flex gap-2">
              <input ref={pathRef} value={rootPath} onChange={(e) => setRootPath(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void submit()}
                placeholder="C:\projects\my-app  —  the project takes the folder's name"
                className="h-10 min-w-0 flex-1 rounded-lg border px-4 font-mono text-[12px]"
                style={is} />
              {isTauri() || !demoData ? (
                <button onClick={() => void handleBrowse()} disabled={picking}
                  className="h-10 shrink-0 flex items-center gap-1.5 rounded-lg border px-3.5 text-[12px] font-semibold disabled:opacity-60"
                  style={{ background: styles.surfaceWell, borderColor: styles.clayRim, color: styles.textSecondary }}>
                  <FolderOpen size={13} /> Browse
                </button>
              ) : null}
            </div>
            {pickHint && <p className="mt-1.5 text-[11px]" style={{ color: styles.textTertiary }}>{pickHint}</p>}
          </div>
          {formError && (
            <p role="alert" className="rounded-lg border px-3 py-2 text-[12px] font-semibold"
              style={{ borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.3), background: withAlpha(SEMANTIC_COLORS.danger, 0.08), color: SEMANTIC_COLORS.danger }}>
              {formError}
            </p>
          )}
          <button onClick={() => void submit()}
            disabled={rootPath.trim().length === 0 || createProject.isPending}
            // R126 (COMPONENTS §4): the quiet-solid clay primary — the DEEP
            // accent fill + contrast ink, rounded-lg (the input tier), the
            // press collapse via the shadow swap. The pill radius + the
            // self-border are retired (the solid-accent pill was the nova
            // dialect).
            className="ac-clay-pressed h-10 w-full rounded-lg font-semibold text-[13px] transition-[opacity,transform] hover:opacity-90 active:scale-[0.98] disabled:opacity-50"
            style={{ background: styles.accentDeep, color: styles.accentText }}>
            {createProject.isPending ? "Creating…" : "Create Project"}
          </button>
        </div>
      </div>
    </div>
  );
}
