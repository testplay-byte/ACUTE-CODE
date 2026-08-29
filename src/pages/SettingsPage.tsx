import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import {
  fetchOrchestrationSettings,
  updateOrchestrationSettings,
  type OrchestrationSettings,
} from "../lib/api";
import { ArrowLeft, Bot, Moon, Palette, Server, SlidersHorizontal, Sun, Users } from "lucide-react";
import { useConfigStore } from "../lib/config-store";
import { useThemeStore } from "../lib/theme-store";
import { THEMES, getContrastText } from "../lib/themes";
import { useThemeStyles } from "../lib/use-theme-styles";
import { AgentsScreen } from "../components/agents/AgentsScreen";
import { ModelsProvidersTab } from "../components/settings/ModelsProvidersTab";
import { SubAgentsSection, SubAgentsTab } from "../components/settings/SubAgentsTab";
import { Button, Field, inputClass } from "../components/ui/controls";
import { bdr, withAlpha } from "../components/dashboard/helpers";

const TABS = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "api", label: "Models & Providers", icon: Server },
  // ROUND-43 (R43-5, owner directive): the temporary sub-agent section —
  // dedicated API-key paste slots + model override. Deep-link ?tab=subagents.
  { id: "subagents", label: "Sub-agents", icon: Users },
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
      <div className="shrink-0 border-b-[1.5px] px-5 md:px-8 py-4" style={{ borderColor: styles.border }}>
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
          room); the appearance page constrains itself internally. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 md:px-8 py-5 mx-auto w-full max-w-5xl">
        {/* ROUND-35 (owner: "above the appearance but below the top heading"):
          the back-to-dashboard affordance lives HERE in the content area. */}
        <div className="mb-5">
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
        {tab === "api" && <ModelsProvidersTab />}
        {tab === "subagents" && <SubAgentsTab />}
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
  // ROUND-34 (owner's appearance design): density + sidebar tint controls.
  const density = useThemeStore((s) => s.density);
  const setDensity = useThemeStore((s) => s.setDensity);
  const sidebarTint = useThemeStore((s) => s.sidebarTint);
  const setSidebarTint = useThemeStore((s) => s.setSidebarTint);
  // ROUND-35 (owner: tool calls preferences in settings).
  const activityMode = useThemeStore((s) => s.activityMode);
  const setActivityMode = useThemeStore((s) => s.setActivityMode);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5">
      {/* ── Interface Mode (owner design: segmented toggle + LIVE badge) ── */}
      <section>
        <SectionTitle>Interface Mode</SectionTitle>
        <div
          className="relative grid w-full max-w-[320px] grid-cols-2 gap-1.5 rounded-[16px] p-1"
          role="radiogroup"
          aria-label="Interface mode"
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
        <p className="mt-2 text-[11px]" style={{ color: styles.textTertiary }}>
          Changes apply live across the whole app.
        </p>
      </section>

      <section>
        <SectionTitle>Theme</SectionTitle>
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

      {/* ── Density (owner design frame 2) ──────────────────────────────── */}
      <section>
        <SectionTitle>Density</SectionTitle>
        <div
          className="relative grid w-full max-w-[320px] grid-cols-2 gap-1.5 rounded-[16px] p-1"
          role="radiogroup"
          aria-label="Density"
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
          Comfortable adds breathing room to the chat; compact fits more on screen.
        </p>
      </section>

      {/* ── Tool Calls (ROUND-35: the owner's tool-calls preferences) ──── */}
      <section>
        <SectionTitle>Tool Calls</SectionTitle>
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
                {/* Tiny inline mock of the mode */}
                <div className="mt-2.5 rounded-[8px] border p-1.5 flex flex-col gap-1" style={{ borderColor: styles.borderSubtle }}>
                  {id === "detailed" && (
                    <>
                      <div className="h-[5px] w-3/4 rounded-full" style={{ background: withAlpha(styles.accent, 0.5) }} />
                      <div className="h-[5px] w-full rounded-full" style={{ background: withAlpha("#22c55e", 0.5) }} />
                      <div className="h-[5px] w-2/3 rounded-full" style={{ background: withAlpha(styles.text, 0.2) }} />
                    </>
                  )}
                  {id === "compact" && (
                    <div className="h-[5px] w-full rounded-full" style={{ background: withAlpha(styles.accent, 0.5) }} />
                  )}
                  {id === "hidden" && (
                    <div className="text-[9px] font-mono text-center py-0.5" style={{ color: styles.textTertiary }}>
                      — none —
                    </div>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </section>

      {/* ── Sidebar tint (owner design frame 2) + live mini rail preview ── */}
      <section>
        <SectionTitle>Sidebar Tint</SectionTitle>
        <div className="flex items-start gap-4 flex-wrap">
          <div
            className="relative grid w-full max-w-[320px] grid-cols-3 gap-1.5 rounded-[16px] p-1"
            role="radiogroup"
            aria-label="Sidebar tint strength"
            style={{ background: styles.toggleTrack, border: bdr("1.5px", styles.border) }}
          >
            <div
              className="absolute bottom-1 top-1 w-[calc(33.33%-4.66px)] rounded-[12px] transition-all duration-300"
              style={{
                left:
                  sidebarTint === "subtle"
                    ? "4px"
                    : sidebarTint === "warm"
                      ? "calc(33.33% + 0.33px)"
                      : "calc(66.66% - 4.33px)",
                background: styles.toggleActive,
              }}
            />
            {(["subtle", "warm", "bold"] as const).map((t) => {
              const active = sidebarTint === t;
              return (
                <button
                  key={t}
                  onClick={() => setSidebarTint(t)}
                  role="radio"
                  aria-checked={active}
                  aria-label={`${t} sidebar tint`}
                  className="relative z-10 flex h-10 cursor-pointer items-center justify-center rounded-[12px] border-none bg-transparent text-[12px] font-bold capitalize transition-colors"
                  style={{ color: active ? getContrastText(styles.toggleActive) : styles.textTertiary }}
                >
                  {t}
                </button>
              );
            })}
          </div>
          {/* Live mini rail preview — shows the resulting sidebar surface. */}
          <div
            className="w-[104px] h-[112px] rounded-[14px] border-[1.5px] overflow-hidden shrink-0"
            style={{ borderColor: styles.border, background: styles.bg }}
            aria-hidden
          >
            <div className="h-full w-[42px] p-2 flex flex-col gap-1.5" style={{ background: styles.sidebarBg }}>
              <div className="h-3 w-3 rounded-[4px]" style={{ background: styles.accent }} />
              <div className="h-[5px] w-full rounded-full" style={{ background: withAlpha(styles.text, 0.18) }} />
              <div className="h-[5px] w-3/4 rounded-full" style={{ background: withAlpha(styles.text, 0.14) }} />
              <div className="h-[5px] w-2/3 rounded-full mt-2" style={{ background: withAlpha(styles.accent, 0.45) }} />
              <div className="h-[5px] w-1/2 rounded-full" style={{ background: withAlpha(styles.text, 0.12) }} />
            </div>
          </div>
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

/* ── Advanced (data source) ─────────────────────────────── */

function AdvancedTab() {
  const { baseUrl, token, demoData, setBaseUrl, setToken, setDemoData } = useConfigStore();
  const styles = useThemeStyles();
  const [urlDraft, setUrlDraft] = useState(baseUrl);
  const [tokenDraft, setTokenDraft] = useState(token ?? "");
  const [saved, setSaved] = useState(false);

  const save = () => {
    setBaseUrl(urlDraft);
    setToken(tokenDraft.trim() || null);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      {/* ROUND-43 (R43-5): the temporary sub-agent keys + model cards also
          render here until the sidebar gains a dedicated "Sub-agents" entry
          (Sidebar.tsx SETTINGS_SECTIONS is owned by the sidebar agent this
          wave) — keeps them discoverable via Advanced meanwhile. */}
      <SubAgentsSection />
      <OrchestrationCard />
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
    </div>
  );
}


/* ── ROUND-36 (ADR-0022): sub-agent orchestration limits ─────────────────── */

function OrchestrationCard() {
  const styles = useThemeStyles();
  const settingsQuery = useQuery({
    queryKey: ["orchestration-settings"],
    queryFn: fetchOrchestrationSettings,
  });
  const [draft, setDraft] = useState<{ maxParallel?: number; perKeyLimit?: number }>({});
  const [msg, setMsg] = useState<string | null>(null);
  const queryClientRef = useQueryClient();

  const update = useMutation({
    mutationFn: (patch: Partial<OrchestrationSettings>) => updateOrchestrationSettings(patch),
    onSuccess: () => {
      void queryClientRef?.invalidateQueries({ queryKey: ["orchestration-settings"] });
      setMsg("Saved.");
      setDraft({});
      setTimeout(() => setMsg(null), 1500);
    },
    onError: (err: Error) => setMsg(err.message),
  });

  const current = settingsQuery.data;
  if (settingsQuery.isLoading || current === undefined) {
    return (
      <section className="rounded-lg p-4" style={{ background: styles.card, border: bdr("1.5px", styles.border) }}>
        <span className="text-[12px] font-mono" style={{ color: styles.textTertiary }}>
          loading orchestration settings…
        </span>
      </section>
    );
  }

  const stepper = (label: string, hint: string, field: "maxParallel" | "perKeyLimit", min: number, max: number) => (
    <div className="flex items-center gap-3 flex-wrap">
      <div className="min-w-[180px]">
        <div className="text-[12.5px] font-bold" style={{ color: styles.text }}>{label}</div>
        <div className="text-[11px]" style={{ color: styles.textTertiary }}>{hint}</div>
      </div>
      <span className="flex-1" />
      <div className="flex items-center gap-1.5">
        {[-1, +1].map((delta) => (
          <button
            key={delta}
            onClick={() => {
              const base = draft[field] ?? current[field];
              setDraft((d) => ({ ...d, [field]: Math.min(max, Math.max(min, base + delta)) }));
            }}
            aria-label={`${delta > 0 ? "Increase" : "Decrease"} ${label}`}
            className="w-8 h-8 rounded-[10px] grid place-items-center border-[1.5px] text-[14px] font-black"
            style={{ borderColor: styles.border, color: styles.textSecondary, background: styles.bg }}
          >
            {delta > 0 ? "+" : "−"}
          </button>
        ))}
        <span
          className="w-14 text-center text-[15px] font-black tabular-nums rounded-[10px] py-1"
          style={{ background: withAlpha(styles.accent, 0.09), color: styles.accent }}
        >
          {draft[field] ?? current[field]}
        </span>
      </div>
    </div>
  );

  const dirty = draft.maxParallel !== undefined || draft.perKeyLimit !== undefined;

  return (
    <section className="rounded-lg p-4 flex flex-col gap-4" style={{ background: styles.card, border: bdr("1.5px", styles.border) }}>
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-bold uppercase tracking-widest" style={{ color: styles.textTertiary }}>
          Sub-Agent Orchestration
        </span>
        {msg && <span className="text-[11px] font-bold" style={{ color: styles.accent }}>{msg}</span>}
      </div>
      {stepper("Max parallel sub-agents", "Total concurrent sub-agent sessions (1–50)", "maxParallel", 1, 50)}
      {stepper("Per API-key limit", "Concurrent sub-agents per API key — protects rate limits (1–20)", "perKeyLimit", 1, 20)}
      <div className="flex items-center gap-3">
        <p className="text-[11px] flex-1" style={{ color: styles.textTertiary }}>
          Sub-agents prefer dedicated key-pool slots (managed per provider in Models &amp; Providers) over the primary key.
        </p>
        <button
          onClick={() => update.mutate(draft)}
          disabled={!dirty || update.isPending}
          className="h-9 px-4 rounded-full text-[12px] font-bold disabled:opacity-50"
          style={{ background: styles.accent, color: styles.accentText }}
        >
          {update.isPending ? "Saving…" : "Save"}
        </button>
      </div>
    </section>
  );
}
