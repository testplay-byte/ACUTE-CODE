import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import {
  fetchMemorySettings,
  updateMemorySettings,
} from "../lib/api";
import { ArrowLeft, Bot, Brain, Monitor, Moon, Palette, PlugZap, Server, SlidersHorizontal, Sparkles, Sun, Users } from "lucide-react";
import { useConfigStore } from "../lib/config-store";
import { useThemeStore } from "../lib/theme-store";
import { THEMES, getContrastText } from "../lib/themes";
import { useTimeoutClear } from "../hooks/use-timeout-clear";
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
import { Button, Field, inputClass } from "../components/ui/controls";
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
  { id: "advanced", label: "Advanced", icon: SlidersHorizontal },
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

/* ── Advanced (data source) ───────────────────────────────
 * ROUND-58 (R58-d): the sub-agent cards NO LONGER render here (pre-R58 the
 * whole SubAgentsSection + the OrchestrationCard rendered on BOTH the
 * subagents tab AND here — the owner: "the subagent and advanced options are
 * apparently mixed up"). ?tab=subagents is the single home for everything
 * sub-agent; Advanced keeps exactly the engine connection + agent memory. */

function AdvancedTab() {
  const { baseUrl, token, demoData, setBaseUrl, setToken, setDemoData } = useConfigStore();
  const styles = useThemeStyles();
  const [urlDraft, setUrlDraft] = useState(baseUrl);
  const [tokenDraft, setTokenDraft] = useState(token ?? "");
  const [saved, setSaved] = useState(false);
  // ROUND-57-a flake rule: the transient "Saved" reset rides the leak-safe
  // scheduler (the old bare setTimeout outlived happy-dom teardown).
  const resetAfter = useTimeoutClear();

  const save = () => {
    setBaseUrl(urlDraft);
    setToken(tokenDraft.trim() || null);
    setSaved(true);
    resetAfter(() => setSaved(false), 1500);
  };

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      {/* ROUND-58 (R58-d): short section header — the page is now exactly the
          engine connection + the memory master switch, with a pointer to the
          Sub-agents page that owns the rest. */}
      <div className="pb-1">
        <h2 className="text-[16px] font-black" style={{ color: styles.text }}>
          Advanced
        </h2>
        <p className="mt-1 text-[12px]" style={{ color: styles.textSecondary }}>
          Engine connection + agent memory. Sub-agent keys, model, parallelism, and supervision
          live on the{" "}
          <Link to="/settings?tab=subagents" className="font-bold underline" style={{ color: styles.accent }}>
            Sub-agents
          </Link>{" "}
          page.
        </p>
      </div>
      <section
        className="rounded-lg p-4"
        style={{ background: styles.card, border: bdr("1.5px", styles.border) }}
      >
        <div className="mb-3 flex items-center gap-2">
          <Server size={13} style={{ color: styles.accent, opacity: 0.7 }} />
          <span className="text-[12px] font-semibold" style={{ color: styles.text }}>
            Agent core connection
          </span>
        </div>
        <div className="flex flex-col gap-3">
          <Field label="Base URL" hint="Loopback REST address of the sidecar">
            <input
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              className={inputClass}
              style={{ background: styles.inputBg, borderColor: styles.inputBorder, color: styles.text }}
            />
          </Field>
          <Field label="Bearer token" hint="Ephemeral in production; fixed for dev:full">
            <input
              value={tokenDraft}
              onChange={(e) => setTokenDraft(e.target.value)}
              className={inputClass}
              style={{ background: styles.inputBg, borderColor: styles.inputBorder, color: styles.text }}
            />
          </Field>
          <label className="flex cursor-pointer items-center gap-2 text-[12px]" style={{ color: styles.text }}>
            <input
              type="checkbox"
              checked={demoData}
              onChange={(e) => setDemoData(e.target.checked)}
              className="h-4 w-4 cursor-pointer"
            />
            Demo data (fixture adapter when the sidecar is unreachable)
          </label>
          <div className="flex items-center gap-2">
            <Button onClick={save}>Save connection</Button>
            {saved ? (
              <span className="text-[11px]" style={{ color: styles.textTertiary }}>
                Saved — reload to apply.
              </span>
            ) : null}
          </div>
        </div>
      </section>
      <MemoryCard />
    </div>
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
