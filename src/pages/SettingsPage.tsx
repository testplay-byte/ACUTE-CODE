import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import {
  fetchBrowserSettings,
  fetchDebugSettings,
  fetchDesktopNotificationsSettings,
  fetchMemorySettings,
  fetchRetrySettings,
  fetchThinkingLoopSettings,
  updateBrowserSettings,
  updateDebugSettings,
  updateDesktopNotificationsSettings,
  updateMemorySettings,
  updateRetrySettings,
  updateThinkingLoopSettings,
  type BrowserQuickLink,
  type BrowserSettings,
  type RetrySettings,
  type ThinkingLoopSettings,
} from "../lib/api";
// R102-C: the section list + search keywords moved to the ONE shared module
// (settings-sections.ts) — the app sidebar's restored SETTINGS MODE renders
// from the same list, so the id-sync discipline is enforced by construction.
// The icon imports the page itself still needs (cards, not nav): BarChart3
// (the Data-insights cross-link card), SlidersHorizontal (the Debug card),
// Info (the browser-engine line), plus the interactive-set below.
import { BarChart3, Brain, Check, Globe, Info, Minus, Moon, Plus, RefreshCw, RotateCcw, SlidersHorizontal, Sun, Timer, Trash2 } from "lucide-react";
// R98-J: the desktop-notifications card's BellRing icon (the bridge card
// lives in AdvancedTab beside DebugModeCard).
import { BellRing } from "lucide-react";
// R102-C: the ONE section list (see settings-sections.ts for the history).
import {
  SETTINGS_SECTIONS,
  type SettingsSectionId,
} from "../components/settings/settings-sections";
import { DataStatsPanel } from "../components/usage/DataStatsPanel";
// R98-J: the LIVE in-memory push of the switch to the notification bridge
// (the bridge caches the flag so a flip applies to the very next record).
import { setDesktopNotificationsEnabled } from "../lib/desktop-notifications";
// R99-A: the central link router's live-push leg — the Browser tab's "Link
// opening" card pushes every fresh GET + confirmed flip into the router's
// in-memory cache so the next link click obeys without a restart (the
// setDesktopNotificationsEnabled pattern).
import { setLinkOpeningMode } from "../lib/open-link";
import { useThemeStore } from "../lib/theme-store";
import { THEMES, getContrastText } from "../lib/themes";
import { useThemeStyles } from "../lib/use-theme-styles";
// R97-I part 3 (the state-awareness sweep): the settings cards' honest
// error states ride the documented semantic tokens (§1/§6) — never a
// divergent hardcoded red.
import { SEMANTIC_COLORS } from "../lib/semantics";
import { AgentsScreen } from "../components/agents/AgentsScreen";
import { ModelsProvidersTab } from "../components/settings/ModelsProvidersTab";
import { SubAgentsTab } from "../components/settings/SubAgentsTab";
// ROUND-61 (R61): the extensibility tabs — skills (multiple user-addable
// prompt modules), MCP servers (user-configured stdio tool servers), and
// computer use (the desktop-control master switch + the SEPARATE vision
// model). Deep-links: ?tab=skills / ?tab=mcp / ?tab=computeruse.
import { SkillsTab } from "../components/settings/SkillsTab";
// ROUND-98 (R98-E1/E3, owner directive): the PROMPT-CUSTOMIZATION tab — the
// per-project system-prompt section overrides (the R59-F engine finally on
// REST) + the live composed preview. Deep-link ?tab=prompts.
import { PromptsTab } from "../components/settings/PromptsTab";
// ROUND-87 (R87): the About tab — version, updates, and the reset.
import { AboutTab } from "../components/settings/AboutTab";
import { McpTab } from "../components/settings/McpTab";
import { ComputerUseTab } from "../components/settings/ComputerUseTab";
// ROUND-66 (R66, B3/B5, owner directive): the DEDICATED image-analysis
// (vision) section — the model+key config moved OUT of Computer Use per the
// owner's "remove the vision model from there and create a dedicated
// section" directive. Deep-link ?tab=vision.
import { ImageAnalysisTab } from "../components/settings/ImageAnalysisTab";
// ROUND-106 (R106-S2): the DEVICES tab — the desktop half of device linking
// (the allow-links toggle, the QR+PIN pairing window, the linked-devices
// list with revoke). Deep-link ?tab=devices.
import { DevicesTab } from "../components/settings/DevicesTab";
import { bdr, withAlpha } from "../components/dashboard/helpers";
// R100-E1 (research §C2 P1(b)): the round-100 ui/ primitives — the settings
// page's own cards ride SectionCard, its label+control rows ride SettingsRow,
// and every kicker (page, group headers, in-card labels) is the ONE Kicker
// spelling (11px/500/0.08em uppercase — TOKENS §2's label tier).
import { Kicker } from "../components/ui/Kicker";
import { SectionCard } from "../components/ui/SectionCard";
import { SettingsRow } from "../components/ui/SettingsRow";
import { cn } from "../lib/utils";

// R98-I1 (owner: "add a dedicated section for functionality… separate the
// different side options into different categories, like basic agent
// capabilities, data and statistics"): the GROUPED settings map — every
// entry carries a `group` (the five owner-named categories).
// R102-C: the TABS list + SEARCH_KEYWORDS map MOVED — their ONE home is
// ../components/settings/settings-sections.ts (the app sidebar's restored
// SETTINGS MODE renders from the same list; the id-sync discipline is now
// enforced by construction instead of by mirror-comment). The per-entry
// history comments moved with them.

/**
 * Settings (owner round-8): the ONE place for configuration — appearance
 * (theme + mode moved here from the deleted top bar), agents management
 * (moved out of the sidebar), API keys per provider with a live connection
 * test, and the advanced data-source panel. Deep-linkable via ?tab=.
 *
 * R102-C (owner v0.99.0: "the left sidebar does not change and the settings
 * sidebar shows on the right side of the left sidebar … handle it just like
 * how it was handled previously"): the R100-E1 settings-local nav column is
 * RETIRED — the doubled sidebar is gone. The APP SIDEBAR becomes the
 * settings nav on /settings (Sidebar.tsx's restored settings mode: back
 * pill + search + the grouped section list + the About update dot), and
 * THIS page is the content pane alone. The tab state machine is UNTOUCHED:
 * the sidebar's nav clicks write the same ?tab= param the deep links have
 * always used; below md the mobile drawer carries the same settings nav.
 * R106-S2: the Devices tab (?tab=devices) joins the render map — the
 * settings-sections.ts list is the ONE source (the sidebar's settings mode
 * renders from the same module, so the nav picks it up by construction).
 */
export function SettingsPage() {
  const [params] = useSearchParams();
  const tabParam = params.get("tab");
  const tab: SettingsSectionId = (
    SETTINGS_SECTIONS.find((t) => t.id === tabParam)?.id ?? "appearance"
  ) as SettingsSectionId;

  // ROUND-34: the in-page tab bar is GONE — the sidebar is the settings nav
  // (owner design frame 1a). The page header adapts per section.
  const activeMeta = SETTINGS_SECTIONS.find((t) => t.id === tab) ?? SETTINGS_SECTIONS[0];

  return (
    <div className="flex h-full flex-col">
      {/* ROUND-60 (R60-B): the owner's padding directive — "All of the
          settings have a lot of extra unnecessary padding on the right and
          left sides… minimize the padding as much as possible." The header
          strip drops to px-4/px-6.
          R100-E1 (research §C2 P1(d)): the header = the label-tier Kicker +
          the 24px/600 title (the old 11px-bold/0.18em + font-black pair was
          the pre-round-100 spelling the ladder retired). */}
      <div className="shrink-0 border-b border-line px-4 md:px-6 py-4">
        <Kicker className="mb-1">Settings</Kicker>
        <h1 className="text-[24px] font-semibold tracking-tight text-ink">{activeMeta.label}</h1>
      </div>

      {/* R102-C: the settings-local nav column is DELETED — the app sidebar
          (left) is the settings nav on /settings; this page is the content
          pane alone, full width. The ?tab= machine + every deep link keep
          working unchanged. */}
      <div className="flex min-h-0 flex-1 flex-col">
        {/* ROUND-34: wider content (the master-detail provider screen needs the
            room); the appearance page constrains itself internally.
            ROUND-50 (R50-d): for Models & Providers the content area LOCKS to
            the viewport (overflow-hidden, no page scroll) — the tab's provider
            list and detail pane each scroll INDEPENDENTLY (owner directive).
            ROUND-60 (R60-B): the padding is minimal (px-4/px-6, py-4) and the
            Models & Providers tab fills the FULL available width — no max-w
            cap, no mx-auto centering (the master-detail owns every pixel);
            the form tabs keep a tighter max-w-4xl for readable lines. */}
        <div
          className={
            tab === "api"
              ? "flex min-h-0 flex-1 flex-col overflow-hidden px-4 md:px-6 py-4 w-full"
              : "min-h-0 flex-1 overflow-y-auto px-4 md:px-6 py-4 mx-auto w-full max-w-4xl"
          }
        >
          {/* ROUND-35 → ROUND-95 (R95-A): the "Back to dashboard" pill that
              used to live HERE is GONE — the owner: "on any of the pages there
              is no need to show the Back to Dashboard page button. The only
              place where the option needs to be shown is in the left sidebar."
              R102-C: the sidebar's restored SETTINGS MODE carries that back
              affordance at its very top (the R95-A labeled pill). */}
          {tab === "appearance" && <AppearanceTab />}
          {tab === "agents" && <AgentsScreen embedded />}
          {tab === "api" && (
            <div className="flex min-h-0 flex-1 flex-col">
              <ModelsProvidersTab />
            </div>
          )}
          {tab === "subagents" && <SubAgentsTab />}
          {tab === "skills" && <SkillsTab />}
          {tab === "prompts" && <PromptsTab />}
          {tab === "mcp" && <McpTab />}
          {tab === "computeruse" && <ComputerUseTab />}
          {tab === "vision" && <ImageAnalysisTab />}
          {tab === "browser" && <BrowserTab />}
          {tab === "devices" && <DevicesTab />}
          {tab === "data" && <DataStatsPanel />}
          {tab === "advanced" && <AdvancedTab />}
          {tab === "about" && <AboutTab />}
        </div>
      </div>
    </div>
  );
}

/* ── Appearance ─────────────────────────────────────────── */

function AppearanceTab() {
  const styles = useThemeStyles();
  const themeId = useThemeStore((s) => s.themeId);
  const setTheme = useThemeStore((s) => s.setTheme);
  const mode = useThemeStore((s) => s.mode);
  const setMode = useThemeStore((s) => s.setMode);
  // ROUND-34 (owner's appearance design): density control.
  const density = useThemeStore((s) => s.density);
  const setDensity = useThemeStore((s) => s.setDensity);
  // ROUND-35 (owner: tool calls preferences in settings).
  const activityMode = useThemeStore((s) => s.activityMode);
  const setActivityMode = useThemeStore((s) => s.setActivityMode);
  // R97-H (owner: the chat window's "overall functionality, usability,
  // customizability"): the text-size ladder + the hover timestamps.
  const chatTextSize = useThemeStore((s) => s.chatTextSize);
  const setChatTextSize = useThemeStore((s) => s.setChatTextSize);
  const timestampsMode = useThemeStore((s) => s.timestampsMode);
  const setTimestampsMode = useThemeStore((s) => s.setTimestampsMode);

  return (
    // ROUND-62 (R62-2a, owner: "in the settings in the appearence make it
    // simple easier and much better and also remove the unnecessary not
    // configured settings"): the tab is ONE simple column at gap-4 — the
    // mode + theme sections are MERGED, the tool cards lose their mock
    // previews, and the never-configured "Sidebar Tint" section is removed
    // (UI-only — the theme-store field stays, other surfaces still read it).
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      {/* ── Theme: light/dark segmented control directly above the grid ── */}
      <section>
        <Kicker as="h2" className="mb-2">
          Theme
        </Kicker>
        {/* R100-E1 ladder sweep: radii snap to the 5-step scale (16 card /
            12 inner knob), labels follow the weight law (500 active, 400
            rest), max-w-[320px] → max-w-80 (the scale spelling). */}
        <div
          className="relative mb-3 grid w-full max-w-80 grid-cols-2 gap-1.5 rounded-2xl p-1"
          role="radiogroup"
          aria-label="Theme mode"
          style={{ background: styles.toggleTrack, border: bdr("1.5px", styles.border) }}
        >
          <div
            className="absolute bottom-1 top-1 w-[calc(50%-6px)] rounded-xl transition-all duration-300"
            style={{ left: mode === "dark" ? "calc(50% + 2px)" : "4px", background: styles.toggleActive }}
          />
          {(["light", "dark"] as const).map((m) => {
            const Icon = m === "light" ? Sun : Moon;
            const active = mode === m;
            return (
              <button
                key={m}
                onClick={() => setMode(m)}
                role="radio"
                aria-checked={active}
                aria-label={`${m} mode`}
                className={cn(
                  "relative z-10 flex h-10 cursor-pointer items-center justify-center gap-1.5 rounded-xl border-none bg-transparent text-[13px] capitalize transition-colors",
                  active ? "font-medium" : "font-normal",
                )}
                style={{ color: active ? getContrastText(styles.toggleActive) : styles.textTertiary }}
              >
                <Icon size={14} />
                {m}
              </button>
            );
          })}
        </div>
        {/* 2-column grid (1 per row on mobile) — modern, compact, shows more at once */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {THEMES.map((t) => {
            const selected = t.id === themeId;
            const colors = mode === "dark" ? t.paletteDark : t.paletteLight;
            return (
              <button
                key={t.id}
                onClick={() => setTheme(t.id)}
                aria-pressed={selected}
                aria-label={`Theme ${t.name}`}
                className={cn(
                  "relative flex cursor-pointer items-center gap-3 rounded-2xl border-[1.5px] bg-card px-4 py-3 text-left transition-colors hover:bg-hover",
                  // R107-g: the selected card carries the chrome hairline —
                  // the reflective top-edge glint on the chosen theme (the
                  // liquid-chrome jewelry; COMPONENTS §8). Unselected cards
                  // stay quiet.
                  selected ? "border-accent ac-chrome-edge" : "border-line",
                )}
                style={
                  selected
                    ? { boxShadow: `${styles.bentoShadowSm}, 0 0 0 3px ${withAlpha(styles.accent, 0.18)}` }
                    : undefined
                }
              >
                <span
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-full border text-[13px] font-semibold"
                  style={{ background: t.accent, borderColor: styles.border, color: getContrastText(t.accent) }}
                >
                  Aa
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium" style={{ color: styles.text }}>
                    {t.name}
                  </span>
                  {/* Swatch strip: subtle bg + strong border so dark swatches
                       stay visible against the dark card bg (owner R28 fix).
                       R100-E1: 14px swatches on the scale (h-3.5/w-3.5),
                       4px radius (rounded-sm), 2px pad (p-0.5). */}
                  <span
                    className="mt-1 flex gap-1 rounded-sm p-0.5"
                    style={{ background: withAlpha(styles.text, 0.06), border: `1px solid ${withAlpha(styles.text, 0.18)}` }}
                  >
                    {colors.map((c, i) => (
                      <span
                        key={i}
                        className="h-3.5 w-3.5 rounded-sm"
                        style={{ background: c, border: `1px solid ${withAlpha(styles.text, 0.22)}` }}
                      />
                    ))}
                  </span>
                </span>
                {selected ? (
                  <span
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-[12px]"
                    style={{ background: styles.accent, color: getContrastText(styles.accent) }}
                  >
                    {/* R100-E1: the one-spelling rule — lucide glyph, not a
                        text ✓ (the wave-D discipline). */}
                    <Check size={12} aria-hidden />
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </section>

      {/* ── Chat density (owner design frame 2) ─────────────────────────── */}
      <section>
        <Kicker as="h2" className="mb-2">
          Chat Density
        </Kicker>
        <div
          className="relative grid w-full max-w-80 grid-cols-2 gap-1.5 rounded-2xl p-1"
          role="radiogroup"
          aria-label="Chat density"
          style={{ background: styles.toggleTrack, border: bdr("1.5px", styles.border) }}
        >
          <div
            className="absolute bottom-1 top-1 w-[calc(50%-6px)] rounded-xl transition-all duration-300"
            style={{ left: density === "compact" ? "calc(50% + 2px)" : "4px", background: styles.toggleActive }}
          />
          {(["comfortable", "compact"] as const).map((d) => {
            const active = density === d;
            return (
              <button
                key={d}
                onClick={() => setDensity(d)}
                role="radio"
                aria-checked={active}
                aria-label={`${d} density`}
                className={cn(
                  "relative z-10 flex h-10 cursor-pointer items-center justify-center rounded-xl border-none bg-transparent text-[13px] capitalize transition-colors",
                  active ? "font-medium" : "font-normal",
                )}
                style={{ color: active ? getContrastText(styles.toggleActive) : styles.textTertiary }}
              >
                {d}
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-[11px]" style={{ color: styles.textTertiary }}>
          Compact fits more on screen.
        </p>
      </section>

      {/* ── R97-H: chat text size (the owner's customizability ask) ──── */}
      <section>
        <Kicker as="h2" className="mb-2">
          Text Size
        </Kicker>
        <p className="mt-0 mb-3 text-[12px]" style={{ color: styles.textSecondary }}>
          The chat's reading surfaces — answers, thinking, narration.
        </p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {(
            [
              { id: "small", label: "Small", desc: "Tightens a dense working session" },
              { id: "medium", label: "Medium", desc: "The default reading size" },
              { id: "large", label: "Large", desc: "Reads better at a distance" },
            ] as const
          ).map(({ id, label, desc }) => (
            <ChoiceCard
              key={id}
              active={chatTextSize === id}
              label={label}
              desc={desc}
              onSelect={() => setChatTextSize(id)}
            />
          ))}
        </div>
      </section>

      {/* ── R97-H: message timestamps ────────────────────────────────── */}
      <section>
        <Kicker as="h2" className="mb-2">
          Timestamps
        </Kicker>
        <p className="mt-0 mb-3 text-[12px]" style={{ color: styles.textSecondary }}>
          When a message was sent, revealed by hovering it.
        </p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {(
            [
              { id: "hidden", label: "Hidden", desc: "The clean default — no time labels" },
              { id: "hover", label: "On hover", desc: "Hovering a message reveals its time chip" },
            ] as const
          ).map(({ id, label, desc }) => (
            <ChoiceCard
              key={id}
              active={timestampsMode === id}
              label={label}
              desc={desc}
              onSelect={() => setTimestampsMode(id)}
            />
          ))}
        </div>
      </section>

      {/* ── Tool activity (ROUND-35: the owner's tool-calls preferences) ── */}
      <section>
        <Kicker as="h2" className="mb-2">
          Tool activity
        </Kicker>
        <p className="mt-0 mb-3 text-[12px]" style={{ color: styles.textSecondary }}>
          How the agent's tool activity appears in the chat.
        </p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {/* R97-J (m8): the section rides the shared ChoiceCard now — the
              R97-H extraction left this inline duplicate behind (byte-
              identical markup). ROUND-62 (2-a): the tiny inline mock previews
              are long gone — label + one-line description only. */}
          {(
            [
              { id: "detailed", label: "Detailed", desc: "Full timeline with diffs and command output" },
              { id: "compact", label: "Compact", desc: "One-line summary per turn" },
              { id: "hidden", label: "Hidden", desc: "Never show tool activity" },
            ] as const
          ).map(({ id, label, desc }) => (
            <ChoiceCard
              key={id}
              active={activityMode === id}
              label={label}
              desc={desc}
              onSelect={() => setActivityMode(id)}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

/** R97-H: the appearance tab's radio card — the exact Tool-activity card
 * pattern (radio circle + one-line description, active accent ring)
 * extracted so the sections speak the same design without duplicating the
 * markup. R100-E1 ladder sweep: 16px card radius (rounded-2xl, the card
 * step), 500 label weight (the law's active/selected tier), hover = the
 * CSS bg wash (the translate fidget is gone — TOKENS §6). */
function ChoiceCard({
  active,
  label,
  desc,
  onSelect,
}: {
  active: boolean;
  label: string;
  desc: string;
  onSelect: () => void;
}) {
  const styles = useThemeStyles();
  return (
    <button
      onClick={onSelect}
      aria-pressed={active}
      className={cn(
        "relative rounded-2xl border-[1.5px] p-3 text-left transition-colors hover:bg-hover",
        active ? "border-accent" : "border-line bg-card",
      )}
      style={
        active
          ? {
              background: withAlpha(styles.accent, 0.06),
              borderColor: styles.accent,
              boxShadow: `0 0 0 3px ${withAlpha(styles.accent, 0.15)}`,
            }
          : undefined
      }
    >
      <div className="flex items-center gap-2">
        <span
          className="w-4 h-4 rounded-full border-[1.5px] grid place-items-center shrink-0"
          style={{
            borderColor: active ? styles.accent : styles.border,
            background: active ? styles.accent : "transparent",
          }}
          aria-hidden
        >
          {active && <span className="w-1.5 h-1.5 rounded-full" style={{ background: styles.accentText }} />}
        </span>
        <span className="text-[13px] font-medium" style={{ color: styles.text }}>
          {label}
        </span>
      </div>
      <p className="mt-1.5 text-[11px] leading-snug" style={{ color: styles.textSecondary }}>
        {desc}
      </p>
    </button>
  );
}

/* R100-E1: SectionTitle is DELETED — every 11px-uppercase section heading is
 * the Kicker primitive now (the ONE label-tier spelling, 11px/500/0.08em
 * tertiary — the old hand-rolled bold/widest variant was exactly the
 * four-spellings problem the round-100 ladder retired). */

/* ── API & Providers ──────────────────────────────────────
 * ROUND-47 (R47-c1): the legacy ApiTab / ProviderKeyCard pair is DELETED —
 * dead code since the ROUND-37 ModelsProvidersTab rebuild took over the
 * "api" tab (verified: zero imports anywhere in src/). Models & Providers
 * is the one provider surface now. */

/* ── Advanced (URL id) / Functionality (R98-I1 label) ────────────────────
 * ROUND-58 (R58-d): the sub-agent cards NO LONGER render here (pre-R58 the
 * whole SubAgentsSection + the OrchestrationCard rendered on BOTH the
 * subagents tab AND here — the owner: "the subagent and advanced options are
 * apparently mixed up"). ?tab=subagents is the single home for everything
 * sub-agent.
 *
 * ROUND-65 (R65, owner directive): the "Agent core connection" card (Base
 * URL / Bearer token / Demo data / Save connection) is REMOVED — the owner
 * called those irrelevant: the desktop app manages the sidecar itself
 * (ephemeral token injected by the Rust shell; the fields only ever made
 * sense in web dev mode). The config-store fields survive untouched
 * (dev-mode wiring + tests read them); only this UI is gone.
 *
 * ROUND-78 (R78-C, owner: "General Settings 重试配置"): the tab's label was
 * "General" then (the URL id stays "advanced" — every existing ?tab=advanced
 * deep link + doc keeps working; the URL contract is load-bearing) and it
 * gained the Auto-retry card (per-failure-type retry switches) ABOVE the
 * debug switch — retry behavior is a general engine setting, not an
 * advanced curiosity.
 *
 * ROUND-98 (R98-I1, owner: "add a dedicated section for functionality…
 * separate the different side options into different categories, like basic
 * agent capabilities, data and statistics"): the label is "Functionality"
 * now (the owner's word) and the cards sit under TWO category headers —
 * "Basic agent capabilities" (retry + thinking-loop + debug + memory +
 * desktop notifications) and "Data & insights" (one cross-link card to the
 * Data & Statistics tab, the owner's second category). */

function AdvancedTab() {
  const styles = useThemeStyles();

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      {/* R98-I1: short section header — the tab is the engine's behavior
          switches under its two categories, with the standing pointer to
          the Sub-agents page that owns the rest.
          R100-E1 (research §C2 P1(d)): the tab-intro header is the label
          tier + a 13px/600 section title — a TAB, not a page (the page
          header above already carries the 24px/600 title). */}
      <div className="pb-1">
        <Kicker className="mb-1">System</Kicker>
        <h2 className="text-[13px] font-semibold text-ink">Functionality</h2>
        <p className="mt-1 text-[12px]" style={{ color: styles.textSecondary }}>
          The engine&apos;s behavior switches, grouped by category. Sub-agent keys, model, parallelism, and supervision
          live on the{" "}
          <Link to="/settings?tab=subagents" className="font-medium underline" style={{ color: styles.accent }}>
            Sub-agents
          </Link>{" "}
          page.
        </p>
      </div>
      {/* R98-I1 category header — the owner's "basic agent capabilities":
          the five engine cards (retry, thinking-loop, debug, desktop
          notifications, memory). */}
      <Kicker as="h2" className="mb-2">
        Basic agent capabilities
      </Kicker>
      <RetryConfigCard />
      <ThinkingLoopCard />
      <DebugModeCard />
      <DesktopNotificationsCard />
      <MemoryCard />
      {/* R98-I1 category header — the owner's "data and statistics": one
          cross-link card pointing at the Data & Statistics tab below. */}
      <Kicker as="h2" className="mb-2">
        Data &amp; insights
      </Kicker>
      <DataInsightsCrossLinkCard />
    </div>
  );
}

/* ── R98-I1: the Data & insights category's ONE card — a cross-link to the
 * Data & Statistics tab (the owner's second category name, "data and
 * statistics"). R100-E1: the card rides the SectionCard primitive now
 * (rounded-2xl/1.5px/border-line/bg-card) with its 13px/600 title — the
 * inline rounded-lg p-4 + bdr() spelling is gone. */
function DataInsightsCrossLinkCard() {
  const styles = useThemeStyles();
  return (
    <SectionCard testId="data-insights-crosslink-card" ariaLabel="Data and insights">
      <div className="mb-3 flex items-center gap-2">
        <BarChart3 size={13} style={{ color: styles.accent, opacity: 0.7 }} />
        <span className="text-[13px] font-semibold text-ink">Data &amp; insights</span>
      </div>
      <div className="text-[11px] leading-relaxed" style={{ color: styles.textTertiary }}>
        Total tokens, peak day, the activity heatmap, the model mix, and agent health live on the{" "}
        <Link to="/settings?tab=data" className="font-medium underline" style={{ color: styles.accent }}>
          Data &amp; Statistics
        </Link>{" "}
        tab — the usage ledger the engine records on every turn.
      </div>
    </SectionCard>
  );
}

/* ── R97-I part 3: the settings cards' shared ERROR state. The pre-R97 gate
 * (`isLoading || current === undefined`) swallowed a failed GET into an
 * ETERNAL "loading …" line — data undefined never resolves, so a 401 or a
 * down sidecar looked like latency. Each card now renders this (the round's
 * retryable-error shape, cf. AgentChatPanel's ChatLoadErrorCard: role=alert,
 * the danger token via withAlpha, the exact cause, ONE Retry action that
 * re-drives the query) INSIDE its own <section>, so the card's testid and
 * column rhythm survive. */
function SettingsLoadErrorCard({
  what,
  error,
  onRetry,
}: {
  what: string;
  error: unknown;
  onRetry: () => void;
}) {
  const styles = useThemeStyles();
  const cause = error instanceof Error ? error.message : String(error);
  return (
    <div
      role="alert"
      data-settings-load-error
      className="rounded-2xl border px-4 py-3.5"
      style={{
        borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.35),
        background: withAlpha(SEMANTIC_COLORS.danger, 0.08),
      }}
    >
      {/* R100-E1: 13px/600 (the error heading is a section header, the
          weight law's 600 tier — the old 12.5px-bold was off-ladder twice). */}
      <div className="text-[13px] font-semibold" style={{ color: SEMANTIC_COLORS.danger }}>
        Could not load {what} settings
      </div>
      <p className="mt-1.5 text-[12px] leading-relaxed" style={{ color: styles.textSecondary }}>
        The agent sidecar may be down or the request was rejected — {cause}. Nothing was changed; Retry
        re-reads the saved value.
      </p>
      <button
        type="button"
        onClick={onRetry}
        aria-label={`Retry loading ${what} settings`}
        className="mt-3 h-8 cursor-pointer rounded-lg border px-3.5 text-[12px] font-semibold transition-opacity hover:opacity-85"
        style={{ borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.45), color: SEMANTIC_COLORS.danger }}
      >
        Retry
      </button>
    </div>
  );
}

/* ── ROUND-97 (R97-D): the THINKING-LOOP card — the owner's "give the user
 * the option in the settings to turn it on or off. By default it will be
 * turned off so that the model can think as much as it needs to" directive.
 * The master switch (DEFAULT OFF — the model thinks freely; the R95-E
 * watchdog only arms when ON) + the two editable thresholds it consults
 * (the no-progress window and the reasoning volume — BOTH must hold). The
 * RetryConfigCard pattern: shared query key, one mutation, honest error
 * line, loading state, stepper-bounded numbers. */

/** R97-J (m5): a number input that COMMITs on blur/Enter, not per
 * keystroke — typing "5" on the way to "55" no longer PUTs a clamped 30
 * mid-edit (the homepage + quick-link inputs' discipline, applied to the
 * threshold steppers). The draft is local until commit; Enter and blur both
 * commit (clamped); Escape abandons. */
function CommitNumberInput({
  value,
  min,
  max,
  step,
  onCommit,
  testId,
  ariaLabel,
  disabled,
  style,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onCommit: (v: number) => void;
  testId: string;
  ariaLabel: string;
  disabled: boolean;
  style: React.CSSProperties;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) return; // abandoned — the input re-reads the store
    const clamped = Math.min(max, Math.max(min, Math.round(parsed)));
    if (clamped !== value) onCommit(clamped);
  };
  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      data-testid={testId}
      aria-label={ariaLabel}
      value={draft ?? String(value)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          setDraft(null);
        }
      }}
      className="h-7 w-21 rounded-lg px-2 font-mono text-[12px] outline-none transition-colors shrink-0 disabled:cursor-not-allowed disabled:opacity-60"
      style={style}
    />
  );
}

function ThinkingLoopCard() {
  const styles = useThemeStyles();
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: ["thinking-loop-settings"],
    queryFn: fetchThinkingLoopSettings,
  });
  const [error, setError] = useState<string | null>(null);

  const update = useMutation({
    mutationFn: (patch: Partial<ThinkingLoopSettings>) => updateThinkingLoopSettings(patch),
    onSuccess: () => {
      setError(null);
      // The engine reads these at TURN start — a flip applies to the next
      // message (the same per-turn semantics as every other card here).
      void queryClient.invalidateQueries({ queryKey: ["thinking-loop-settings"] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const current = settingsQuery.data;
  // R97-I part 3: the ERROR branch comes FIRST — with the pre-R97 gate a
  // failed GET (data undefined) hung on "loading…" forever. Stale data on a
  // background-refetch failure still renders the card normally below.
  // R100-E1: the card rides the SectionCard primitive (rounded-2xl,
  // 1.5px border-line, bg-card) — same testid, same branches.
  if (settingsQuery.isError && current === undefined) {
    return (
      <SectionCard testId="thinking-loop-card">
        <SettingsLoadErrorCard
          what="thinking-loop"
          error={settingsQuery.error}
          onRetry={() => void settingsQuery.refetch()}
        />
      </SectionCard>
    );
  }
  if (settingsQuery.isLoading || current === undefined) {
    return (
      <SectionCard testId="thinking-loop-card">
        <span className="text-[12px] font-mono" style={{ color: styles.textTertiary }}>
          loading thinking-loop settings…
        </span>
      </SectionCard>
    );
  }

  const busy = update.isPending;

  const setStallSeconds = (value: number) => {
    const clamped = Math.min(600, Math.max(30, Math.round(value)));
    if (clamped === current.stallSeconds) return;
    update.mutate({ stallSeconds: clamped });
  };

  const setReasoningBytesKB = (value: number) => {
    const clamped = Math.min(256, Math.max(8, Math.round(value)));
    if (clamped === current.reasoningBytesKB) return;
    update.mutate({ reasoningBytesKB: clamped });
  };

  const inputStyle = {
    background: styles.subtle,
    border: bdr("1.5px", styles.border),
    color: styles.text,
  } as const;

  return (
    <SectionCard testId="thinking-loop-card" ariaLabel="Thinking-loop guard">
      <div className="mb-3 flex items-center gap-2">
        <Brain size={13} style={{ color: styles.accent, opacity: 0.7 }} />
        <span className="text-[13px] font-semibold text-ink">Thinking-loop guard</span>
      </div>
      {/* The master switch — OFF by default (the owner's directive: the model
          thinks as much as it needs to). R100-E1: the row rides SettingsRow
          (13px/400 label + 11px tertiary description + right control slot). */}
      <SettingsRow
        label="Stop stuck reasoning"
        description="When ON, a model that keeps reasoning with no text, tool call, or finish for the stall window below is stopped (one de-escalating retry, then an honest notice). OFF (default) — the model thinks as long as it needs to."
      >
        <button
          type="button"
          role="switch"
          aria-checked={current.enabled}
          aria-label="Toggle the thinking-loop guard"
          data-testid="thinking-loop-switch"
          disabled={busy}
          onClick={() => update.mutate({ enabled: !current.enabled })}
          className="relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors disabled:cursor-wait disabled:opacity-60"
          style={{
            background: current.enabled ? styles.accent : withAlpha(styles.text, 0.18),
            border: bdr("1.5px", current.enabled ? styles.accent : styles.border),
          }}
        >
          <span
            className="absolute top-1/2 block -translate-y-1/2 rounded-full shadow transition-all"
            style={{
              left: current.enabled ? "calc(100% - 21px)" : "3px",
              height: 18,
              width: 18,
              background: current.enabled ? styles.accentText : styles.toggleActive,
            }}
          />
        </button>
      </SettingsRow>

      {/* The thresholds — editable only while the guard is ON (the honest
          “nothing to edit while off” posture; they still render so the
          contract is visible). */}
      <div className="mt-4 border-t border-line pt-3">
        <div className="mb-2.5 flex items-center gap-2">
          <Timer size={12} style={{ color: styles.accent, opacity: 0.7 }} />
          <span className="text-[13px] font-semibold text-ink">Thresholds</span>
        </div>
        <SettingsRow
          label="Stall window"
          description="Seconds of pure reasoning with no progress before the guard fires (30–600)."
        >
          <CommitNumberInput
            value={current.stallSeconds}
            min={30}
            max={600}
            step={30}
            onCommit={setStallSeconds}
            testId="thinking-loop-stall"
            ariaLabel="Stall window in seconds"
            disabled={busy || !current.enabled}
            style={inputStyle}
          />
        </SettingsRow>
        <SettingsRow
          label="Reasoning volume"
          description="KB of reasoning accumulated in that window before the guard fires (8–256). Both conditions must hold."
        >
          <CommitNumberInput
            value={current.reasoningBytesKB}
            min={8}
            max={256}
            step={4}
            onCommit={setReasoningBytesKB}
            testId="thinking-loop-bytes"
            ariaLabel="Reasoning volume in KB"
            disabled={busy || !current.enabled}
            style={inputStyle}
          />
        </SettingsRow>
      </div>

      {error ? (
        <div className="mt-2 text-[11px]" style={{ color: SEMANTIC_COLORS.danger }} role="alert">
          {error}
        </div>
      ) : null}
      <div className="mt-3 text-[11px] leading-relaxed" style={{ color: styles.textTertiary }}>
        {current.enabled
          ? `The guard fires after ${current.stallSeconds}s of pure reasoning with ${current.reasoningBytesKB}KB accumulated — one de-escalating retry, then an honest amber notice (never a red “generation failed”).`
          : "OFF — the model can think as much as it needs to. Turn it on only if a model ever gets stuck in a true reasoning loop."}
      </div>
    </SectionCard>
  );
}

/* ── ROUND-78 (R78-C): the Auto-retry card — per-failure-type gates for the
 * transient-API retry ladder. The DebugModeCard pattern exactly: a shared
 * ["retry-settings"] query key, one mutation per field, an honest error
 * line, a loading state. When a switch is OFF that failure class never
 * ladders — it fails fast through the honest terminal path with the
 * provider's REAL error text, which is the whole point of the R78
 * honest-errors round.
 * ROUND-80 (R80, owner: "in the settings retry customization is needed"):
 * the card grew the SCHEDULE section — the max-attempts stepper, one
 * editable wait input per rung, the provider-call timeout, and Reset to
 * defaults. Every edit rides the same PUT /settings/retry mutation
 * (validated server-side); the engine resolves the schedule per turn, so
 * changes apply to the next message. */

/** The three switches: settings key + row label + one-line description.
 * R80: keyed to the BOOLEAN fields only (RetrySettings also carries the
 * numeric schedule now — the union would widen current[key]). */
const RETRY_SWITCHES: ReadonlyArray<{
  key: "autoRetryRateLimit" | "autoRetryTimeout" | "autoRetryNetwork";
  label: string;
  description: string;
}> = [
  {
    key: "autoRetryRateLimit",
    label: "Rate limits (429)",
    description: "429 responses from the provider.",
  },
  {
    key: "autoRetryTimeout",
    label: "Timeouts",
    description: "Requests that exceed the provider call timeout.",
  },
  {
    key: "autoRetryNetwork",
    label: "Network errors",
    description: "Connection resets, DNS failures, dropped streams.",
  },
];

function RetryConfigCard() {
  const styles = useThemeStyles();
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: ["retry-settings"],
    queryFn: fetchRetrySettings,
  });
  const [error, setError] = useState<string | null>(null);

  const toggle = useMutation({
    mutationFn: (patch: Partial<RetrySettings>) => updateRetrySettings(patch),
    onSuccess: () => {
      setError(null);
      // The engine reads these settings at TURN start — a flip applies to
      // the next message (the same per-turn semantics as debug mode); only
      // the settings state itself refetches here.
      void queryClient.invalidateQueries({ queryKey: ["retry-settings"] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const current = settingsQuery.data;
  // R97-I part 3: the ERROR branch comes FIRST — with the pre-R97 gate a
  // failed GET (data undefined) hung on "loading…" forever. Stale data on a
  // background-refetch failure still renders the card normally below.
  // R100-E1: SectionCard primitive (same testid, same branches).
  if (settingsQuery.isError && current === undefined) {
    return (
      <SectionCard testId="retry-settings-card">
        <SettingsLoadErrorCard
          what="retry"
          error={settingsQuery.error}
          onRetry={() => void settingsQuery.refetch()}
        />
      </SectionCard>
    );
  }
  if (settingsQuery.isLoading || current === undefined) {
    return (
      <SectionCard testId="retry-settings-card">
        <span className="text-[12px] font-mono" style={{ color: styles.textTertiary }}>
          loading retry settings…
        </span>
      </SectionCard>
    );
  }

  const busy = toggle.isPending;

  /** R80: the human line for the CURRENT schedule — the agent-core
   * describeRetrySchedule phrasing mirrored client-side (the footnote and
   * the card copy never hardcode the R75 rungs again). */
  const scheduleLabel = current.waitMinutes
    .slice(0, Math.max(0, current.maxAttempts - 1))
    .map((m) => (m === 0 ? "immediately" : m < 1 ? `${Math.round(m * 60)} s` : `${m % 1 === 0 ? m : m.toFixed(1)} min`))
    .join(", ");

  /** R80: one editable wait input per rung (attempt 2..maxAttempts). */
  const rungCount = Math.max(1, current.maxAttempts - 1);
  const rungs = Array.from({ length: rungCount }, (_, i) => i);

  const setMaxAttempts = (value: number) => {
    const clamped = Math.min(10, Math.max(2, Math.round(value)));
    if (clamped === current.maxAttempts) return;
    toggle.mutate({ maxAttempts: clamped });
  };

  const setRungWait = (index: number, value: number) => {
    const clamped = Math.min(1440, Math.max(0, value));
    if (clamped === current.waitMinutes[index]) return;
    const next = [...current.waitMinutes];
    // Pad with the defaults so the stored row always covers the rungs the
    // current maxAttempts will resolve (the resolver pads too — belt + braces).
    while (next.length < rungCount) next.push(30);
    next[index] = clamped;
    toggle.mutate({ waitMinutes: next.slice(0, 9) });
  };

  const setProviderTimeout = (value: number) => {
    const clamped = Math.min(3600, Math.max(60, Math.round(value)));
    if (clamped === current.providerTimeoutSeconds) return;
    toggle.mutate({ providerTimeoutSeconds: clamped });
  };

  const resetDefaults = () => {
    toggle.mutate({
      autoRetryRateLimit: true,
      autoRetryTimeout: true,
      autoRetryNetwork: true,
      maxAttempts: 6,
      waitMinutes: [0, 1.5, 5, 10, 30],
      providerTimeoutSeconds: 600,
    });
  };

  const inputStyle = {
    background: styles.subtle,
    border: bdr("1.5px", styles.border),
    color: styles.text,
  } as const;

  return (
    <SectionCard testId="retry-settings-card" ariaLabel="Auto-retry">
      <div className="mb-3 flex items-center gap-2">
        <RefreshCw size={13} style={{ color: styles.accent, opacity: 0.7 }} />
        <span className="text-[13px] font-semibold text-ink">Auto-retry</span>
      </div>
      {/* R100-E1: the three switch rows ride SettingsRow (the primitive's
          13px/400 label + 11px tertiary description anatomy). */}
      <div className="flex flex-col gap-1">
        {RETRY_SWITCHES.map(({ key, label, description }) => (
          <SettingsRow key={key} label={label} description={description}>
            <button
              type="button"
              role="switch"
              aria-checked={current[key]}
              aria-label={`Toggle auto-retry for ${label.toLowerCase()}`}
              data-testid={`retry-switch-${key}`}
              disabled={busy}
              onClick={() => toggle.mutate({ [key]: !current[key] })}
              className="relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors disabled:cursor-wait disabled:opacity-60"
              style={{
                background: current[key] ? styles.accent : withAlpha(styles.text, 0.18),
                border: bdr("1.5px", current[key] ? styles.accent : styles.border),
              }}
            >
              <span
                className="absolute top-1/2 block h-4.5 w-4.5 -translate-y-1/2 rounded-full shadow transition-all"
                style={{
                  left: current[key] ? "calc(100% - 21px)" : "3px",
                  height: 18,
                  width: 18,
                  // R93-A4: contrast-aware knob (Mono Stone dark → #111111).
                  background: current[key] ? styles.accentText : styles.toggleActive,
                }}
              />
            </button>
          </SettingsRow>
        ))}
      </div>

      {/* R80: the CUSTOMIZABLE schedule — max attempts + per-rung waits +
          the provider call timeout. Every value edits through the same
          PUT /settings/retry mutation (validated server-side against the
          same bounds the runtime resolves with). */}
      <div className="mt-4 border-t border-line pt-3">
        <div className="mb-2.5 flex items-center gap-2">
          <Timer size={12} style={{ color: styles.accent, opacity: 0.7 }} />
          <span className="text-[13px] font-semibold text-ink">Schedule</span>
        </div>

        {/* Max attempts stepper */}
        <SettingsRow label="Max attempts" description="Total provider attempts per turn (initial call + retries).">
          <div className="flex items-center gap-1.5 shrink-0" data-testid="retry-max-attempts-group">
            <button
              type="button"
              aria-label="Decrease max attempts"
              data-testid="retry-max-attempts-minus"
              disabled={busy || current.maxAttempts <= 2}
              onClick={() => setMaxAttempts(current.maxAttempts - 1)}
              className="h-7 w-7 grid place-items-center rounded-lg border transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
              style={inputStyle}
            >
              <Minus size={12} />
            </button>
            <span
              data-testid="retry-max-attempts"
              className="w-8 text-center text-[13px] font-mono font-semibold tabular-nums"
              style={{ color: styles.text }}
            >
              {current.maxAttempts}
            </span>
            <button
              type="button"
              aria-label="Increase max attempts"
              data-testid="retry-max-attempts-plus"
              disabled={busy || current.maxAttempts >= 10}
              onClick={() => setMaxAttempts(current.maxAttempts + 1)}
              className="h-7 w-7 grid place-items-center rounded-lg border transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
              style={inputStyle}
            >
              <Plus size={12} />
            </button>
          </div>
        </SettingsRow>

        {/* Per-rung waits (minutes) — a wrapped input cluster, not a
            single label+control row (stays hand-rolled; sizes snapped). */}
        <div className="mt-3">
          <div className="text-[13px] font-normal text-ink mb-1">Wait before each retry</div>
          <div className="text-[11px] mb-2" style={{ color: styles.textTertiary }}>
            Minutes to wait before each retry attempt (0 = retry immediately).
          </div>
          <div className="flex flex-wrap gap-2">
            {rungs.map((i) => (
              <label key={i} className="flex items-center gap-1.5" data-testid={`retry-wait-row-${i}`}>
                <span className="text-[11px] font-mono shrink-0" style={{ color: styles.textTertiary }}>
                  #{i + 2}
                </span>
                <input
                  type="number"
                  min={0}
                  max={1440}
                  step={0.5}
                  disabled={busy}
                  data-testid={`retry-wait-${i}`}
                  aria-label={`Wait in minutes before retry attempt ${i + 2}`}
                  value={current.waitMinutes[i] ?? 30}
                  onChange={(e) => {
                    const parsed = Number(e.target.value);
                    if (Number.isFinite(parsed)) setRungWait(i, parsed);
                  }}
                  onBlur={(e) => {
                    // Out-of-range blur snaps back to the persisted value
                    // (the server rejects out-of-bounds — never a stuck
                    // invalid input).
                    const parsed = Number(e.target.value);
                    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1440) {
                      e.target.value = String(current.waitMinutes[i] ?? 30);
                    }
                  }}
                  className="h-7 w-18 rounded-lg px-2 font-mono text-[12px] outline-none transition-colors disabled:cursor-wait disabled:opacity-60"
                  style={inputStyle}
                />
                <span className="text-[11px] font-mono shrink-0" style={{ color: styles.textTertiary }}>
                  min
                </span>
              </label>
            ))}
          </div>
        </div>

        {/* Provider call timeout */}
        <SettingsRow
          label="Provider call timeout"
          description="Seconds before a stuck provider call aborts (then retries if timeouts are on)."
          className="mt-3"
        >
          <input
            type="number"
            min={60}
            max={3600}
            step={30}
            disabled={busy}
            data-testid="retry-timeout"
            aria-label="Provider call timeout in seconds"
            value={current.providerTimeoutSeconds}
            onChange={(e) => {
              const parsed = Number(e.target.value);
              if (Number.isFinite(parsed)) setProviderTimeout(parsed);
            }}
            onBlur={(e) => {
              const parsed = Number(e.target.value);
              if (!Number.isFinite(parsed) || parsed < 60 || parsed > 3600) {
                e.target.value = String(current.providerTimeoutSeconds);
              }
            }}
            className="h-7 w-21 rounded-lg px-2 font-mono text-[12px] outline-none transition-colors shrink-0 disabled:cursor-wait disabled:opacity-60"
            style={inputStyle}
          />
        </SettingsRow>

        {/* Reset to defaults */}
        <div className="mt-3">
          <button
            type="button"
            disabled={busy}
            data-testid="retry-reset"
            onClick={resetDefaults}
            className="h-7 px-2.5 rounded-lg text-[12px] font-semibold border transition-colors inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ borderColor: styles.border, color: styles.textSecondary }}
          >
            <RotateCcw size={11} />
            Reset to defaults
          </button>
        </div>
      </div>

      {error ? (
        <div className="mt-2 text-[11px]" style={{ color: SEMANTIC_COLORS.danger }} role="alert">
          {error}
        </div>
      ) : null}
      <div className="mt-3 text-[11px] leading-relaxed" style={{ color: styles.textTertiary }}>
        When a switch is off, that failure type shows immediately with the provider&apos;s real error text instead of
        auto-retrying ({current.maxAttempts} attempts: {scheduleLabel}).
      </div>
    </SectionCard>
  );
}

/* ── ROUND-65 (R65): the debug-mode switch — the owner's "debug mode"
 * directive. ROUND-66 (R66, C1) REWORK: the main agent NO LONGER
 * self-reports (no prompt change at all — its answers stay clean). When ON,
 * the turn COMPLETES normally and THEN a completely fresh, context-free
 * debug analyst receives the whole conversation transcript + every tool
 * call's full result and streams its execution report LIVE into a dedicated
 * section at the bottom of the turn (never fed back to the agent — follow-up
 * messages are unaffected). The engine reads this setting per turn, so a
 * flip applies to the very next message. OFF (default) = no analyst. */

function DebugModeCard() {
  const styles = useThemeStyles();
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: ["debug-settings"],
    queryFn: fetchDebugSettings,
  });
  const [error, setError] = useState<string | null>(null);

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => updateDebugSettings({ enabled }),
    onSuccess: () => {
      setError(null);
      // The very next agent turn reads this setting server-side (per-turn,
      // like the permission mode) — only the switch state itself refetches.
      void queryClient.invalidateQueries({ queryKey: ["debug-settings"] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const current = settingsQuery.data;
  // R97-I part 3: the ERROR branch comes FIRST — with the pre-R97 gate a
  // failed GET (data undefined) hung on "loading…" forever. Stale data on a
  // background-refetch failure still renders the card normally below.
  if (settingsQuery.isError && current === undefined) {
    return (
      <SectionCard>
        <SettingsLoadErrorCard
          what="debug"
          error={settingsQuery.error}
          onRetry={() => void settingsQuery.refetch()}
        />
      </SectionCard>
    );
  }
  if (settingsQuery.isLoading || current === undefined) {
    return (
      <SectionCard>
        <span className="text-[12px] font-mono" style={{ color: styles.textTertiary }}>
          loading debug settings…
        </span>
      </SectionCard>
    );
  }

  const busy = toggle.isPending;

  return (
    <SectionCard ariaLabel="Debug mode">
      <div className="mb-3 flex items-center gap-2">
        <SlidersHorizontal size={13} style={{ color: styles.accent, opacity: 0.7 }} />
        <span className="text-[13px] font-semibold text-ink">Debug mode</span>
      </div>
      <SettingsRow
        label={
          <>
            Post-turn debug analyst
            {error ? (
              <div className="mt-1.5 text-[11px]" style={{ color: SEMANTIC_COLORS.danger }} role="alert">
                {error}
              </div>
            ) : null}
          </>
        }
        description="While ON, the agent answers normally — then a separate, context-free analyst reviews the whole conversation (every tool call's full result, what was resolved, what failed) and streams its execution report live in a dedicated section under the answer. The report never feeds back into the conversation, so follow-up messages stay clean. Applies to the next message you send."
      >
        <button
          type="button"
          role="switch"
          aria-checked={current.enabled}
          aria-label="Toggle debug mode"
          disabled={busy}
          onClick={() => toggle.mutate(!current.enabled)}
          className="relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors disabled:cursor-wait disabled:opacity-60"
          style={{
            background: current.enabled ? styles.accent : withAlpha(styles.text, 0.18),
            border: bdr("1.5px", current.enabled ? styles.accent : styles.border),
          }}
        >
          <span
            className="absolute top-1/2 block h-4.5 w-4.5 -translate-y-1/2 rounded-full shadow transition-all"
            style={{
              left: current.enabled ? "calc(100% - 21px)" : "3px",
              height: 18,
              width: 18,
              // R93-A4: contrast-aware knob (Mono Stone dark → #111111).
              background: current.enabled ? styles.accentText : styles.toggleActive,
            }}
          />
        </button>
      </SettingsRow>
    </SectionCard>
  );
}


/* ── ROUND-98 (R98-J, owner: task complete / failed / permission needed →
 * "it will send me a notification on my PC"): the DESKTOP-NOTIFICATIONS
 * switch — gates the Tauri notification bridge's OS-notification fan-out.
 * The DebugModeCard pattern exactly (one query, one mutation, honest
 * error + loading states, R97-I error-first gates) PLUS the LIVE
 * in-memory push: the bridge (src/lib/desktop-notifications.ts) caches
 * the enabled flag in memory, and every confirmed flip (and every fresh
 * GET) is pushed there immediately — a flip applies to the very next
 * record, no restart, no refetch of the bridge. */

function DesktopNotificationsCard() {
  const styles = useThemeStyles();
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: ["desktop-notifications-settings"],
    queryFn: fetchDesktopNotificationsSettings,
  });
  const [error, setError] = useState<string | null>(null);

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => updateDesktopNotificationsSettings({ enabled }),
    onSuccess: (data) => {
      setError(null);
      // R98-J: the LIVE push — the bridge's in-memory gate flips NOW (the
      // server row below is the durable truth; this is the live one).
      setDesktopNotificationsEnabled(data.enabled);
      void queryClient.invalidateQueries({ queryKey: ["desktop-notifications-settings"] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const current = settingsQuery.data;

  // R98-J: sync the bridge's in-memory gate with the server truth whenever
  // a fresh GET lands (a restart + a previously-OFF row must not fire
  // notifications until the card is opened — this closes that gap). Above
  // the early returns: hooks stay unconditional (the Rules of Hooks).
  useEffect(() => {
    if (current === undefined) return;
    setDesktopNotificationsEnabled(current.enabled);
  }, [current]);

  // R97-I part 3: the ERROR branch comes FIRST — with the pre-R97 gate a
  // failed GET (data undefined) hung on "loading…" forever. Stale data on a
  // background-refetch failure still renders the card normally below.
  if (settingsQuery.isError && current === undefined) {
    return (
      <SectionCard testId="desktop-notifications-card">
        <SettingsLoadErrorCard
          what="desktop-notifications"
          error={settingsQuery.error}
          onRetry={() => void settingsQuery.refetch()}
        />
      </SectionCard>
    );
  }
  if (settingsQuery.isLoading || current === undefined) {
    return (
      <SectionCard testId="desktop-notifications-card">
        <span className="text-[12px] font-mono" style={{ color: styles.textTertiary }}>
          loading desktop notification settings…
        </span>
      </SectionCard>
    );
  }

  const busy = toggle.isPending;

  return (
    <SectionCard testId="desktop-notifications-card" ariaLabel="Desktop notifications">
      <div className="mb-3 flex items-center gap-2">
        <BellRing size={13} style={{ color: styles.accent, opacity: 0.7 }} />
        <span className="text-[13px] font-semibold text-ink">Desktop notifications</span>
      </div>
      <SettingsRow
        label={
          <>
            OS notifications
            {error ? (
              <div className="mt-1.5 text-[11px]" style={{ color: SEMANTIC_COLORS.danger }} role="alert">
                {error}
              </div>
            ) : null}
          </>
        }
        description="While ON, task-complete, task-failed, and permission-needed alerts fire a native OS notification when the app window is not visible (the same rule the in-app toasts already follow). Sub-agent activity stays in-app only. Applies to the very next notification."
      >
        <button
          type="button"
          role="switch"
          aria-checked={current.enabled}
          aria-label="Toggle desktop notifications"
          disabled={busy}
          onClick={() => toggle.mutate(!current.enabled)}
          className="relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors disabled:cursor-wait disabled:opacity-60"
          style={{
            background: current.enabled ? styles.accent : withAlpha(styles.text, 0.18),
            border: bdr("1.5px", current.enabled ? styles.accent : styles.border),
          }}
        >
          <span
            className="absolute top-1/2 block h-4.5 w-4.5 -translate-y-1/2 rounded-full shadow transition-all"
            style={{
              left: current.enabled ? "calc(100% - 21px)" : "3px",
              height: 18,
              width: 18,
              // R93-A4: contrast-aware knob (Mono Stone dark → #111111).
              background: current.enabled ? styles.accentText : styles.toggleActive,
            }}
          />
        </button>
      </SettingsRow>
    </SectionCard>
  );
}


/* ── ROUND-49: the memory master switch (owner: "maybe try giving me a
 * setting in the settings to turn off this memory functionality") ───────── */

function MemoryCard() {
  const styles = useThemeStyles();
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: ["memory-settings"],
    queryFn: fetchMemorySettings,
  });
  const [error, setError] = useState<string | null>(null);

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => updateMemorySettings({ enabled }),
    onSuccess: () => {
      setError(null);
      // The very next agent turn reads this setting server-side; the panel
      // list query stays as-is (rows are still browsable/deletable while
      // off — deleting works regardless of the switch).
      void queryClient.invalidateQueries({ queryKey: ["memory-settings"] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const current = settingsQuery.data;
  // R97-I part 3: the ERROR branch comes FIRST — with the pre-R97 gate a
  // failed GET (data undefined) hung on "loading…" forever. Stale data on a
  // background-refetch failure still renders the card normally below.
  if (settingsQuery.isError && current === undefined) {
    return (
      <SectionCard>
        <SettingsLoadErrorCard
          what="memory"
          error={settingsQuery.error}
          onRetry={() => void settingsQuery.refetch()}
        />
      </SectionCard>
    );
  }
  if (settingsQuery.isLoading || current === undefined) {
    return (
      <SectionCard>
        <span className="text-[12px] font-mono" style={{ color: styles.textTertiary }}>
          loading memory settings…
        </span>
      </SectionCard>
    );
  }

  const busy = toggle.isPending;

  return (
    <SectionCard ariaLabel="Agent memory">
      <div className="mb-3 flex items-center gap-2">
        <Brain size={13} style={{ color: styles.accent, opacity: 0.7 }} />
        <span className="text-[13px] font-semibold text-ink">Agent memory</span>
      </div>
      <SettingsRow
        label={
          <>
            Project memory system
            {error ? (
              <div className="mt-1.5 text-[11px]" style={{ color: SEMANTIC_COLORS.danger }} role="alert">
                {error}
              </div>
            ) : null}
          </>
        }
        description="While ON, agents auto-load each project's saved facts, decisions and preferences at every turn and can save new ones (memory_save / memory_recall / memory_list). Turn it OFF to run every session on its own context alone — no memory is injected and the memory tools are not offered. Saved memories are kept and restored when re-enabled."
      >
        <button
          type="button"
          role="switch"
          aria-checked={current.enabled}
          aria-label="Toggle agent memory"
          disabled={busy}
          onClick={() => toggle.mutate(!current.enabled)}
          className="relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors disabled:cursor-wait disabled:opacity-60"
          style={{
            background: current.enabled ? styles.accent : withAlpha(styles.text, 0.18),
            border: bdr("1.5px", current.enabled ? styles.accent : styles.border),
          }}
        >
          <span
            className="absolute top-1/2 block h-4.5 w-4.5 -translate-y-1/2 rounded-full shadow transition-all"
            style={{
              left: current.enabled ? "calc(100% - 21px)" : "3px",
              height: 18,
              width: 18,
              // R93-A4: contrast-aware knob (Mono Stone dark → #111111).
              background: current.enabled ? styles.accentText : styles.toggleActive,
            }}
          />
        </button>
      </SettingsRow>
    </SectionCard>
  );
}


/* ── ROUND-97 (R97-G): the BROWSER tab — the owner's dedicated browser section
 * ("which I can use to edit some settings of the browsers, manage the
 * browser"): the address-bar search engine, the homepage, the default zoom for
 * new browser sessions, and the editable quick links (add / edit / remove /
 * reorder up). All values wire straight into the panel's behavior (the engine
 * is the address bar's query fallback; the homepage is the Home button's
 * target; quick links render on the home page). The RetryConfigCard pattern:
 * one query, one mutation, honest error + loading states. */

const SEARCH_ENGINE_OPTIONS: ReadonlyArray<{ id: BrowserSettings["searchEngine"]; label: string; example: string }> = [
  { id: "duckduckgo", label: "DuckDuckGo", example: "duckduckgo.com" },
  { id: "google", label: "Google", example: "google.com" },
  { id: "bing", label: "Bing", example: "bing.com" },
  { id: "brave", label: "Brave", example: "search.brave.com" },
];

function BrowserTab() {
  const styles = useThemeStyles();
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: ["browser-settings"],
    queryFn: fetchBrowserSettings,
  });
  const [error, setError] = useState<string | null>(null);

  const update = useMutation({
    mutationFn: (patch: Partial<BrowserSettings>) => updateBrowserSettings(patch),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ["browser-settings"] });
    },
    onError: (err: Error) => setError(err.message),
  });

  // R99-A: the LIVE push — every fresh GET + every confirmed flip (the
  // onSuccess invalidation above refetches, landing here) seeds the central
  // link router's in-memory cache, so the very next link click anywhere in
  // the app already obeys. Only the two sanctioned spellings land (a value
  // off the enum is not a reason to guess a different mode).
  useEffect(() => {
    const mode = settingsQuery.data?.linkOpeningMode;
    if (mode === "in-app" || mode === "system") {
      setLinkOpeningMode(mode);
    }
  }, [settingsQuery.data]);

  const current = settingsQuery.data;
  // R97-I part 3: the ERROR branch comes FIRST — with the pre-R97 gate a
  // failed GET (data undefined) hung on "loading…" forever. Stale data on a
  // background-refetch failure still renders the card normally below.
  if (settingsQuery.isError && current === undefined) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-4">
        <SectionCard testId="browser-settings-card" ariaLabel="Browser settings">
          <SettingsLoadErrorCard
            what="browser"
            error={settingsQuery.error}
            onRetry={() => void settingsQuery.refetch()}
          />
        </SectionCard>
      </div>
    );
  }
  if (settingsQuery.isLoading || current === undefined) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-4">
        <SectionCard testId="browser-settings-card" ariaLabel="Browser settings">
          <span className="text-[12px] font-mono" style={{ color: styles.textTertiary }}>
            loading browser settings…
          </span>
        </SectionCard>
      </div>
    );
  }

  const busy = update.isPending;
  const inputStyle = {
    background: styles.subtle,
    border: bdr("1.5px", styles.border),
    color: styles.text,
  } as const;

  const setQuickLinks = (links: BrowserQuickLink[]): void => {
    update.mutate({ quickLinks: links });
  };

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      {/* R100-E1 (research §C2 P1(d)): the tab-intro header — label-tier
          Kicker (the tab's group) + a 13px/600 section title. A TAB, not a
          page: the page header above already carries the 24px/600 title
          (the old 16px font-black h2 was the spelling the ladder retired). */}
      <div className="pb-1">
        <Kicker className="mb-1">Integrations</Kicker>
        <h2 className="text-[13px] font-semibold text-ink">Browser</h2>
        <p className="mt-1 text-[12px]" style={{ color: styles.textSecondary }}>
          The embedded browser's address bar, home page, default zoom, link opening, and quick links.
        </p>
      </div>

      {/* R100-A: THE ENGINE LINE — the honest answer to "which browser is
          this?". Round-99 shipped the WebView2 Fixed Version Runtime inside
          the installer (~258 MB) and the owner read it for what it was:
          Microsoft Edge bundled with the app. Round-100 reverts to the
          evergreen runtime + the de-branded panel UA (no `Edg/` token,
          `AcuteBrowser/1.0` identity — src-tauri/src/browser.rs
          `PANEL_USER_AGENT`). This row states the engine plainly so the
          question never needs asking again: no marketing, no hiding. */}
      <div
        data-testid="browser-engine-line"
        className="flex items-start gap-2.5 rounded-lg px-3 py-2.5"
        style={{ background: styles.subtle, border: bdr("1px", styles.border) }}
        role="note"
        aria-label="Browser engine"
      >
        <Info size={13} className="mt-0.5 shrink-0" style={{ color: styles.textTertiary }} />
        <div className="text-[11.5px] leading-[1.5] min-w-0" style={{ color: styles.textSecondary }}>
          <span className="font-semibold" style={{ color: styles.text }}>
            Engine:
          </span>{" "}
          the panel runs the OS webview — WebView2 (Chromium-based, presented with ACUTE's own user agent) on
          Windows, WebKitGTK on Linux. The app never launches your device's browser, and pages identify it as
          ACUTE Browser.
        </div>
      </div>

      <SectionCard testId="browser-settings-card" ariaLabel="Browser settings">
        {/* The search engine — the card's in-card label is the Kicker
            (label tier), the row itself rides SettingsRow. */}
        <Kicker icon={Globe} className="mb-3">
          Address bar
        </Kicker>
        <SettingsRow label="Search engine" description="Used when the address bar text is a query, not a URL.">
          <div className="flex flex-wrap gap-1.5 justify-end" data-testid="browser-engine-group">
            {SEARCH_ENGINE_OPTIONS.map((opt) => {
              const active = current.searchEngine === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  disabled={busy}
                  data-testid={`browser-engine-${opt.id}`}
                  aria-pressed={active}
                  onClick={() => update.mutate({ searchEngine: opt.id })}
                  className="h-7 px-2.5 rounded-lg text-[12px] font-semibold border transition-colors hover:bg-hover cursor-pointer disabled:opacity-50"
                  style={{
                    ...(active
                      ? { background: withAlpha(styles.accent, 0.12), borderColor: styles.accent, color: styles.accent }
                      : { borderColor: styles.border, color: styles.textSecondary }),
                  }}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </SettingsRow>

        {/* The homepage */}
        <SettingsRow
          divider
          label="Home page"
          description={
            <>
              Where the Home button goes. Use <span className="font-mono">acute://home</span> for the quick-links page, or any URL / local path.
            </>
          }
        >
          <input
            type="text"
            disabled={busy}
            data-testid="browser-homepage"
            aria-label="Home page URL"
            defaultValue={current.homepage}
            onBlur={(e) => {
              const value = e.target.value.trim();
              if (value !== current.homepage) update.mutate({ homepage: value });
            }}
            className="h-7 w-55 rounded-lg px-2 font-mono text-[12px] outline-none transition-colors shrink-0 disabled:opacity-60"
            style={inputStyle}
          />
        </SettingsRow>

        {/* The default zoom — tabular-nums on the value (the native-feel
            checklist: numbers never reflow on change). */}
        <SettingsRow divider label="Default zoom" description="New browser sessions start at this zoom (25%–300%).">
          <div className="flex items-center gap-1.5 shrink-0" data-testid="browser-zoom-group">
            <button
              type="button"
              aria-label="Decrease default zoom"
              disabled={busy || current.defaultZoom <= 0.25}
              onClick={() => update.mutate({ defaultZoom: Math.max(0.25, Math.round((current.defaultZoom - 0.25) * 100) / 100) })}
              className="h-7 w-7 grid place-items-center rounded-lg border transition-colors disabled:opacity-40 cursor-pointer"
              style={inputStyle}
            >
              <Minus size={12} />
            </button>
            <span
              data-testid="browser-zoom-value"
              className="w-14 text-center text-[13px] font-mono font-semibold tabular-nums"
              style={{ color: styles.text }}
            >
              {Math.round(current.defaultZoom * 100)}%
            </span>
            <button
              type="button"
              aria-label="Increase default zoom"
              disabled={busy || current.defaultZoom >= 3}
              onClick={() => update.mutate({ defaultZoom: Math.min(3, Math.round((current.defaultZoom + 0.25) * 100) / 100) })}
              className="h-7 w-7 grid place-items-center rounded-lg border transition-colors disabled:opacity-40 cursor-pointer"
              style={inputStyle}
            >
              <Plus size={12} />
            </button>
          </div>
        </SettingsRow>

        {/* R99-A: LINK OPENING — where the app's own links land (chat, file
            previews, the About tab). The shared ChoiceCard pattern (the
            pick-one idiom: radio circle + label + one-line description,
            active accent ring) — a labeled GROUP because the two cards are
            one radio decision (aria-pressed on the cards themselves, the
            Text Size / Timestamps precedent). Applied live via the effect
            above. Stays the ChoiceCard GRID (not a SettingsRow). */}
        <div className="mt-4 border-t border-line pt-3">
          <div className="mb-2">
            <div className="text-[13px] font-normal text-ink">Link opening</div>
            <div className="text-[11px]" style={{ color: styles.textTertiary }}>
              Where links inside the app open — chat, file previews, and the About tab.
            </div>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="group" aria-label="Link opening preference">
            <ChoiceCard
              active={current.linkOpeningMode === "in-app"}
              label="In-app browser (recommended)"
              desc="Links open in ACUTE-CODE's built-in browser panel, beside your work."
              onSelect={() => update.mutate({ linkOpeningMode: "in-app" })}
            />
            <ChoiceCard
              active={current.linkOpeningMode === "system"}
              label="System browser"
              desc="Links open in your device's default browser."
              onSelect={() => update.mutate({ linkOpeningMode: "system" })}
            />
          </div>
        </div>

        {/* The quick links */}
        <div className="mt-4 border-t border-line pt-3">
          <div className="mb-2 flex items-center justify-between">
            <div>
              <div className="text-[13px] font-normal text-ink">Quick links</div>
              <div className="text-[11px]" style={{ color: styles.textTertiary }}>
                The shortcuts on the home page ({current.quickLinks.length}/12).
              </div>
            </div>
            <button
              type="button"
              disabled={busy || current.quickLinks.length >= 12}
              data-testid="browser-quicklink-add"
              onClick={() => setQuickLinks([...current.quickLinks, { label: "New link", url: "https://" }])}
              className="h-7 px-2.5 rounded-lg text-[12px] font-semibold border transition-colors inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-40"
              style={{ borderColor: styles.border, color: styles.textSecondary }}
            >
              <Plus size={11} />
              Add link
            </button>
          </div>
          <div className="flex flex-col gap-1.5" data-testid="browser-quicklink-rows">
            {current.quickLinks.map((link, i) => (
              <div key={i} className="flex items-center gap-1.5" data-testid={`browser-quicklink-row-${i}`}>
                <input
                  type="text"
                  disabled={busy}
                  aria-label={`Quick link ${i + 1} label`}
                  defaultValue={link.label}
                  onBlur={(e) => {
                    const next = [...current.quickLinks];
                    next[i] = { ...next[i]!, label: e.target.value.trim() || link.label };
                    if (next[i]!.label !== link.label) setQuickLinks(next);
                  }}
                  className="h-7 flex-1 min-w-0 rounded-lg px-2 text-[12px] outline-none transition-colors disabled:opacity-60"
                  style={inputStyle}
                />
                <input
                  type="text"
                  disabled={busy}
                  aria-label={`Quick link ${i + 1} URL`}
                  defaultValue={link.url}
                  onBlur={(e) => {
                    const next = [...current.quickLinks];
                    next[i] = { ...next[i]!, url: e.target.value.trim() || link.url };
                    if (next[i]!.url !== link.url) setQuickLinks(next);
                  }}
                  className="h-7 flex-[2] min-w-0 rounded-lg px-2 font-mono text-[11px] outline-none transition-colors disabled:opacity-60"
                  style={inputStyle}
                />
                <button
                  type="button"
                  disabled={busy || current.quickLinks.length <= 1}
                  aria-label={`Remove quick link ${i + 1}`}
                  data-testid={`browser-quicklink-remove-${i}`}
                  onClick={() => setQuickLinks(current.quickLinks.filter((_, j) => j !== i))}
                  className="h-7 w-7 grid place-items-center rounded-lg border shrink-0 transition-colors disabled:opacity-40 cursor-pointer"
                  style={{ ...inputStyle, color: SEMANTIC_COLORS.danger }}
                >
                  <Trash2 size={11} />
                </button>
              </div>
            ))}
          </div>
        </div>

        {error ? (
          <div className="mt-2 text-[11px]" style={{ color: SEMANTIC_COLORS.danger }} role="alert">
            {error}
          </div>
        ) : null}
      </SectionCard>
    </div>
  );
}
