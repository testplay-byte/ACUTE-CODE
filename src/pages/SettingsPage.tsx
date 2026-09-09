import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import {
  fetchDebugSettings,
  fetchMemorySettings,
  fetchRetrySettings,
  updateDebugSettings,
  updateMemorySettings,
  updateRetrySettings,
  type RetrySettings,
} from "../lib/api";
import { ArrowLeft, Bot, Brain, Minus, Monitor, Moon, Palette, Plus, PlugZap, RefreshCw, RotateCcw, ScanEye, Server, SlidersHorizontal, Sparkles, Sun, Timer, Users } from "lucide-react";
import { useThemeStore } from "../lib/theme-store";
import { THEMES, getContrastText } from "../lib/themes";
import { useThemeStyles } from "../lib/use-theme-styles";
import { AgentsScreen } from "../components/agents/AgentsScreen";
import { ModelsProvidersTab } from "../components/settings/ModelsProvidersTab";
import { SubAgentsTab } from "../components/settings/SubAgentsTab";
// ROUND-61 (R61): the extensibility tabs — skills (multiple user-addable
// prompt modules), MCP servers (user-configured stdio tool servers), and
// computer use (the desktop-control master switch + the SEPARATE vision
// model). Deep-links: ?tab=skills / ?tab=mcp / ?tab=computeruse.
import { SkillsTab } from "../components/settings/SkillsTab";
import { McpTab } from "../components/settings/McpTab";
import { ComputerUseTab } from "../components/settings/ComputerUseTab";
// ROUND-66 (R66, B3/B5, owner directive): the DEDICATED image-analysis
// (vision) section — the model+key config moved OUT of Computer Use per the
// owner's "remove the vision model from there and create a dedicated
// section" directive. Deep-link ?tab=vision.
import { ImageAnalysisTab } from "../components/settings/ImageAnalysisTab";
import { bdr, withAlpha } from "../components/dashboard/helpers";

const TABS = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "api", label: "Models & Providers", icon: Server },
  // ROUND-43 (R43-5, owner directive): the temporary sub-agent section —
  // dedicated API-key paste slots + model override. Deep-link ?tab=subagents.
  { id: "subagents", label: "Sub-agents", icon: Users },
  // ROUND-61 (R61, owner directive): the extensibility surface — skills,
  // MCP servers, and computer use (with its separate vision model).
  { id: "skills", label: "Skills", icon: Sparkles },
  { id: "mcp", label: "MCP Servers", icon: PlugZap },
  { id: "computeruse", label: "Computer Use", icon: Monitor },
  // ROUND-66 (R66, owner directive): the dedicated image-analysis section —
  // the vision model's OWN home (provider + model + API key), split out of
  // Computer Use so it also serves the general analyze_image tool.
  { id: "vision", label: "Image Analysis", icon: ScanEye },
  // ROUND-78 (R78-C, owner: "General Settings 重试配置"): the tab is
  // LABELED "General" now — the retry switches belong with the general
  // engine settings, not a scary "Advanced" bin. The id/deep-link STAYS
  // "advanced" (every existing ?tab=advanced link + doc keeps working;
  // the URL contract is load-bearing — changing it would break deep links).
  { id: "advanced", label: "General", icon: SlidersHorizontal },
] as const;

type TabId = (typeof TABS)[number]["id"];

/**
 * Settings (owner round-8): the ONE place for configuration — appearance
 * (theme + mode moved here from the deleted top bar), agents management
 * (moved out of the sidebar), API keys per provider with a live connection
 * test, and the advanced data-source panel. Deep-linkable via ?tab=.
 */
export function SettingsPage() {
  const styles = useThemeStyles();
  const [params] = useSearchParams();
  const tabParam = params.get("tab");
  const tab: TabId = (TABS.find((t) => t.id === tabParam)?.id ?? "appearance") as TabId;

  // ROUND-34: the in-page tab bar is GONE — the sidebar is the settings nav
  // (owner design frame 1a). The page header adapts per section.
  const activeMeta = TABS.find((t) => t.id === tab) ?? TABS[0];

  return (
    <div className="flex h-full flex-col">
      {/* ROUND-60 (R60-B): the owner's padding directive — "All of the
          settings have a lot of extra unnecessary padding on the right and
          left sides… minimize the padding as much as possible." The header
          strip drops to px-4/px-6. */}
      <div className="shrink-0 border-b-[1.5px] px-4 md:px-6 py-4" style={{ borderColor: styles.border }}>
        <p
          className="text-[11px] font-bold uppercase tracking-[0.18em] mb-1"
          style={{ color: styles.textTertiary }}
        >
          Settings
        </p>
        <h1 className="text-[24px] font-black tracking-tight" style={{ color: styles.text }}>
          {activeMeta.label}
        </h1>
      </div>

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
        {/* ROUND-35 (owner: "above the appearance but below the top heading"):
          the back-to-dashboard affordance lives HERE in the content area. */}
        <div className={tab === "api" ? "mb-5 shrink-0" : "mb-5"}>
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-full border-[1.5px] text-[12px] font-bold transition-colors"
            style={{ borderColor: styles.border, color: styles.textSecondary, background: styles.card }}
            onMouseEnter={(e) => (e.currentTarget.style.background = styles.subtleHover)}
            onMouseLeave={(e) => (e.currentTarget.style.background = styles.card)}
          >
            <ArrowLeft size={13} /> Back to dashboard
          </Link>
        </div>
        {tab === "appearance" && <AppearanceTab />}
        {tab === "agents" && <AgentsScreen embedded />}
        {tab === "api" && (
          <div className="flex min-h-0 flex-1 flex-col">
            <ModelsProvidersTab />
          </div>
        )}
        {tab === "subagents" && <SubAgentsTab />}
        {tab === "skills" && <SkillsTab />}
        {tab === "mcp" && <McpTab />}
        {tab === "computeruse" && <ComputerUseTab />}
        {tab === "vision" && <ImageAnalysisTab />}
        {tab === "advanced" && <AdvancedTab />}
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
        <SectionTitle>Theme</SectionTitle>
        <div
          className="relative mb-3 grid w-full max-w-[320px] grid-cols-2 gap-1.5 rounded-[16px] p-1"
          role="radiogroup"
          aria-label="Theme mode"
          style={{ background: styles.toggleTrack, border: bdr("1.5px", styles.border) }}
        >
          <div
            className="absolute bottom-1 top-1 w-[calc(50%-6px)] rounded-[12px] transition-all duration-300"
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
                className="relative z-10 flex h-10 cursor-pointer items-center justify-center gap-1.5 rounded-[12px] border-none bg-transparent text-[13px] font-bold capitalize transition-colors"
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
                className="flex cursor-pointer items-center gap-3 rounded-[14px] border-[1.5px] px-4 py-3 text-left transition-all hover:translate-y-[-1px]"
                style={{
                  background: styles.card,
                  borderColor: selected ? styles.accent : styles.border,
                  boxShadow: selected
                    ? `${styles.bentoShadowSm}, 0 0 0 3px ${withAlpha(styles.accent, 0.18)}`
                    : "none",
                }}
              >
                <span
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-full border text-[13px] font-black"
                  style={{ background: t.accent, borderColor: styles.border, color: getContrastText(t.accent) }}
                >
                  Aa
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-bold" style={{ color: styles.text }}>
                    {t.name}
                  </span>
                  {/* Swatch strip: subtle bg + strong border so dark swatches
                       stay visible against the dark card bg (owner R28 fix). */}
                  <span
                    className="mt-1 flex gap-[3px] rounded-[5px] p-[2px]"
                    style={{ background: withAlpha(styles.text, 0.06), border: `1px solid ${withAlpha(styles.text, 0.18)}` }}
                  >
                    {colors.map((c, i) => (
                      <span
                        key={i}
                        className="h-[14px] w-[14px] rounded-[4px]"
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
                    ✓
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </section>

      {/* ── Chat density (owner design frame 2) ─────────────────────────── */}
      <section>
        <SectionTitle>Chat Density</SectionTitle>
        <div
          className="relative grid w-full max-w-[320px] grid-cols-2 gap-1.5 rounded-[16px] p-1"
          role="radiogroup"
          aria-label="Chat density"
          style={{ background: styles.toggleTrack, border: bdr("1.5px", styles.border) }}
        >
          <div
            className="absolute bottom-1 top-1 w-[calc(50%-6px)] rounded-[12px] transition-all duration-300"
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
                className="relative z-10 flex h-10 cursor-pointer items-center justify-center rounded-[12px] border-none bg-transparent text-[13px] font-bold capitalize transition-colors"
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

      {/* ── Tool activity (ROUND-35: the owner's tool-calls preferences) ── */}
      <section>
        <SectionTitle>Tool activity</SectionTitle>
        <p className="mt-0 mb-3 text-[12px]" style={{ color: styles.textSecondary }}>
          How the agent's tool activity appears in the chat.
        </p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {(
            [
              { id: "detailed", label: "Detailed", desc: "Full timeline with diffs and command output" },
              { id: "compact", label: "Compact", desc: "One-line summary per turn" },
              { id: "hidden", label: "Hidden", desc: "Never show tool activity" },
            ] as const
          ).map(({ id, label, desc }) => {
            const active = activityMode === id;
            return (
              <button
                key={id}
                onClick={() => setActivityMode(id)}
                aria-pressed={active}
                className="relative rounded-[14px] border-[1.5px] p-3 text-left transition-all hover:-translate-y-px"
                style={{
                  background: active ? withAlpha(styles.accent, 0.06) : styles.card,
                  borderColor: active ? styles.accent : styles.border,
                  boxShadow: active ? `0 0 0 3px ${withAlpha(styles.accent, 0.15)}` : "none",
                }}
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
                  <span className="text-[13px] font-bold" style={{ color: styles.text }}>
                    {label}
                  </span>
                </div>
                <p className="mt-1.5 text-[11px] leading-snug" style={{ color: styles.textSecondary }}>
                  {desc}
                </p>
                {/* ROUND-62 (2-a): the tiny inline mock preview (the fake bars
                    + the "— none —" block) is GONE — each card is just the
                    label + one-line description. */}
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  const styles = useThemeStyles();
  return (
    <h2
      className="mb-2 text-[11px] font-bold uppercase tracking-widest"
      style={{ color: styles.textTertiary }}
    >
      {children}
    </h2>
  );
}

/* ── API & Providers ──────────────────────────────────────
 * ROUND-47 (R47-c1): the legacy ApiTab / ProviderKeyCard pair is DELETED —
 * dead code since the ROUND-37 ModelsProvidersTab rebuild took over the
 * "api" tab (verified: zero imports anywhere in src/). Models & Providers
 * is the one provider surface now. */

/* ── Advanced (URL id) / General (R78 label) ─────────────────────
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
 * ROUND-78 (R78-C, owner: "General Settings 重试配置"): the tab's LABEL is
 * "General" now (the URL id stays "advanced" — every existing ?tab=advanced
 * deep link + doc keeps working; the URL contract is load-bearing) and it
 * gained the Auto-retry card (per-failure-type retry switches) ABOVE the
 * debug switch — retry behavior is a general engine setting, not an
 * advanced curiosity. The tab is now: Auto-retry + Debug mode + agent
 * memory. */

function AdvancedTab() {
  const styles = useThemeStyles();

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      {/* R78: short section header — the tab is now the general engine
          settings (auto-retry + debug + memory), with a pointer to the
          Sub-agents page that owns the rest. */}
      <div className="pb-1">
        <h2 className="text-[16px] font-black" style={{ color: styles.text }}>
          General
        </h2>
        <p className="mt-1 text-[12px]" style={{ color: styles.textSecondary }}>
          Auto-retry, debug mode, and agent memory. Sub-agent keys, model, parallelism, and supervision live on the{" "}
          <Link to="/settings?tab=subagents" className="font-bold underline" style={{ color: styles.accent }}>
            Sub-agents
          </Link>{" "}
          page.
        </p>
      </div>
      <RetryConfigCard />
      <DebugModeCard />
      <MemoryCard />
    </div>
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
  if (settingsQuery.isLoading || current === undefined) {
    return (
      <section
        data-testid="retry-settings-card"
        className="rounded-lg p-4"
        style={{ background: styles.card, border: bdr("1.5px", styles.border) }}
      >
        <span className="text-[12px] font-mono" style={{ color: styles.textTertiary }}>
          loading retry settings…
        </span>
      </section>
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
    <section
      data-testid="retry-settings-card"
      className="rounded-lg p-4"
      style={{ background: styles.card, border: bdr("1.5px", styles.border) }}
      aria-label="Auto-retry"
    >
      <div className="mb-3 flex items-center gap-2">
        <RefreshCw size={13} style={{ color: styles.accent, opacity: 0.7 }} />
        <span className="text-[12px] font-semibold" style={{ color: styles.text }}>
          Auto-retry
        </span>
      </div>
      <div className="flex flex-col gap-3">
        {RETRY_SWITCHES.map(({ key, label, description }) => (
          <div key={key} className="flex items-start gap-3">
            <div className="min-w-[200px] flex-1">
              <div className="text-[12.5px] font-bold" style={{ color: styles.text }}>
                {label}
              </div>
              <div className="text-[11px]" style={{ color: styles.textTertiary }}>
                {description}
              </div>
            </div>
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
                className="absolute top-1/2 block h-4.5 w-4.5 -translate-y-1/2 rounded-full bg-white shadow transition-all"
                style={{ left: current[key] ? "calc(100% - 21px)" : "3px", height: 18, width: 18 }}
              />
            </button>
          </div>
        ))}
      </div>

      {/* R80: the CUSTOMIZABLE schedule — max attempts + per-rung waits +
          the provider call timeout. Every value edits through the same
          PUT /settings/retry mutation (validated server-side against the
          same bounds the runtime resolves with). */}
      <div className="mt-4 pt-3" style={{ borderTop: bdr("1.5px", styles.border) }}>
        <div className="mb-2.5 flex items-center gap-2">
          <Timer size={12} style={{ color: styles.accent, opacity: 0.7 }} />
          <span className="text-[12px] font-semibold" style={{ color: styles.text }}>
            Schedule
          </span>
        </div>

        {/* Max attempts stepper */}
        <div className="flex items-center gap-3">
          <div className="min-w-[200px] flex-1">
            <div className="text-[12.5px] font-bold" style={{ color: styles.text }}>
              Max attempts
            </div>
            <div className="text-[11px]" style={{ color: styles.textTertiary }}>
              Total provider attempts per turn (initial call + retries).
            </div>
          </div>
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
              className="w-8 text-center text-[13px] font-mono font-bold"
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
        </div>

        {/* Per-rung waits (minutes) */}
        <div className="mt-3">
          <div className="text-[12.5px] font-bold mb-1" style={{ color: styles.text }}>
            Wait before each retry
          </div>
          <div className="text-[11px] mb-2" style={{ color: styles.textTertiary }}>
            Minutes to wait before each retry attempt (0 = retry immediately).
          </div>
          <div className="flex flex-wrap gap-2">
            {rungs.map((i) => (
              <label key={i} className="flex items-center gap-1.5" data-testid={`retry-wait-row-${i}`}>
                <span className="text-[10.5px] font-mono shrink-0" style={{ color: styles.textTertiary }}>
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
                  className="h-7 w-[74px] rounded-lg px-2 font-mono text-[11.5px] outline-none transition-colors disabled:cursor-wait disabled:opacity-60"
                  style={inputStyle}
                />
                <span className="text-[10.5px] font-mono shrink-0" style={{ color: styles.textTertiary }}>
                  min
                </span>
              </label>
            ))}
          </div>
        </div>

        {/* Provider call timeout */}
        <div className="mt-3 flex items-center gap-3">
          <div className="min-w-[200px] flex-1">
            <div className="text-[12.5px] font-bold" style={{ color: styles.text }}>
              Provider call timeout
            </div>
            <div className="text-[11px]" style={{ color: styles.textTertiary }}>
              Seconds before a stuck provider call aborts (then retries if timeouts are on).
            </div>
          </div>
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
            className="h-7 w-[84px] rounded-lg px-2 font-mono text-[11.5px] outline-none transition-colors shrink-0 disabled:cursor-wait disabled:opacity-60"
            style={inputStyle}
          />
        </div>

        {/* Reset to defaults */}
        <div className="mt-3">
          <button
            type="button"
            disabled={busy}
            data-testid="retry-reset"
            onClick={resetDefaults}
            className="h-7 px-2.5 rounded-lg text-[11.5px] font-semibold border transition-colors inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ borderColor: styles.border, color: styles.textSecondary }}
          >
            <RotateCcw size={11} />
            Reset to defaults
          </button>
        </div>
      </div>

      {error ? (
        <div className="mt-2 text-[11px]" style={{ color: "#e5484d" }} role="alert">
          {error}
        </div>
      ) : null}
      <div className="mt-3 text-[11px] leading-relaxed" style={{ color: styles.textTertiary }}>
        When a switch is off, that failure type shows immediately with the provider&apos;s real error text instead of
        auto-retrying ({current.maxAttempts} attempts: {scheduleLabel}).
      </div>
    </section>
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
  if (settingsQuery.isLoading || current === undefined) {
    return (
      <section className="rounded-lg p-4" style={{ background: styles.card, border: bdr("1.5px", styles.border) }}>
        <span className="text-[12px] font-mono" style={{ color: styles.textTertiary }}>
          loading debug settings…
        </span>
      </section>
    );
  }

  const busy = toggle.isPending;

  return (
    <section
      className="rounded-lg p-4"
      style={{ background: styles.card, border: bdr("1.5px", styles.border) }}
      aria-label="Debug mode"
    >
      <div className="mb-3 flex items-center gap-2">
        <SlidersHorizontal size={13} style={{ color: styles.accent, opacity: 0.7 }} />
        <span className="text-[12px] font-semibold" style={{ color: styles.text }}>
          Debug mode
        </span>
      </div>
      <div className="flex items-start gap-3">
        <div className="min-w-[200px] flex-1">
          <div className="text-[12.5px] font-bold" style={{ color: styles.text }}>
            Post-turn debug analyst
          </div>
          <div className="text-[11px]" style={{ color: styles.textTertiary }}>
            While ON, the agent answers normally — then a separate, context-free analyst reviews the
            whole conversation (every tool call's full result, what was resolved, what failed) and
            streams its execution report live in a dedicated section under the answer. The report
            never feeds back into the conversation, so follow-up messages stay clean. Applies to
            the next message you send.
          </div>
          {error ? (
            <div className="mt-1.5 text-[11px]" style={{ color: "#e5484d" }} role="alert">
              {error}
            </div>
          ) : null}
        </div>
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
            className="absolute top-1/2 block h-4.5 w-4.5 -translate-y-1/2 rounded-full bg-white shadow transition-all"
            style={{ left: current.enabled ? "calc(100% - 21px)" : "3px", height: 18, width: 18 }}
          />
        </button>
      </div>
    </section>
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
  if (settingsQuery.isLoading || current === undefined) {
    return (
      <section className="rounded-lg p-4" style={{ background: styles.card, border: bdr("1.5px", styles.border) }}>
        <span className="text-[12px] font-mono" style={{ color: styles.textTertiary }}>
          loading memory settings…
        </span>
      </section>
    );
  }

  const busy = toggle.isPending;

  return (
    <section
      className="rounded-lg p-4"
      style={{ background: styles.card, border: bdr("1.5px", styles.border) }}
      aria-label="Agent memory"
    >
      <div className="mb-3 flex items-center gap-2">
        <Brain size={13} style={{ color: styles.accent, opacity: 0.7 }} />
        <span className="text-[12px] font-semibold" style={{ color: styles.text }}>
          Agent memory
        </span>
      </div>
      <div className="flex items-start gap-3">
        <div className="min-w-[200px] flex-1">
          <div className="text-[12.5px] font-bold" style={{ color: styles.text }}>
            Project memory system
          </div>
          <div className="text-[11px]" style={{ color: styles.textTertiary }}>
            While ON, agents auto-load each project's saved facts, decisions and preferences at
            every turn and can save new ones (memory_save / memory_recall / memory_list). Turn it
            OFF to run every session on its own context alone — no memory is injected and the
            memory tools are not offered. Saved memories are kept and restored when re-enabled.
          </div>
          {error ? (
            <div className="mt-1.5 text-[11px]" style={{ color: "#e5484d" }} role="alert">
              {error}
            </div>
          ) : null}
        </div>
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
            className="absolute top-1/2 block h-4.5 w-4.5 -translate-y-1/2 rounded-full bg-white shadow transition-all"
            style={{ left: current.enabled ? "calc(100% - 21px)" : "3px", height: 18, width: 18 }}
          />
        </button>
      </div>
    </section>
  );
}
