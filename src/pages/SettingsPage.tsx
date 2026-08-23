import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { Bot, Palette, Server, SlidersHorizontal } from "lucide-react";
import { useConfigStore } from "../lib/config-store";
import { useThemeStore } from "../lib/theme-store";
import { THEMES } from "../lib/themes";
import { useThemeStyles } from "../lib/use-theme-styles";
import { AgentsScreen } from "../components/agents/AgentsScreen";
import { ModelsProvidersTab } from "../components/settings/ModelsProvidersTab";
import { Button, Field, inputClass } from "../components/ui/controls";
import {
  fetchProviders,
  isTauri,
  storeProviderKey,
  testConnection,
  withClientDefaults,
  type ConnectionTestResult,
} from "../components/onboarding/providers-api";
import { bdr, withAlpha } from "../components/dashboard/helpers";

const TABS = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "api", label: "Models & Providers", icon: Server },
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
  const [params, setParams] = useSearchParams();
  const tabParam = params.get("tab");
  const tab: TabId = (TABS.find((t) => t.id === tabParam)?.id ?? "appearance") as TabId;

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b-[1.5px] px-5 md:px-8 py-4" style={{ borderColor: styles.border }}>
        <p
          className="text-[11px] font-bold uppercase tracking-[0.18em] mb-1"
          style={{ color: styles.textTertiary }}
        >
          Configuration
        </p>
        <h1 className="text-[22px] font-black tracking-tight" style={{ color: styles.text }}>
          Settings
        </h1>
        <div className="mt-3.5 flex flex-wrap gap-1.5">
          {TABS.map(({ id, label, icon: Icon }) => {
            const active = id === tab;
            return (
              <button
                key={id}
                onClick={() => setParams({ tab: id }, { replace: true })}
                className="flex cursor-pointer items-center gap-1.5 rounded-[12px] h-9 px-3.5 text-[12px] font-bold transition-all duration-200"
                style={{
                  backgroundColor: active ? styles.accent : "transparent",
                  color: active ? styles.accentText : styles.textSecondary,
                  boxShadow: active ? `0 2px 8px ${withAlpha(styles.accent, 0.3)}` : "none",
                }}
                onMouseEnter={(e) => {
                  if (!active) e.currentTarget.style.background = styles.subtleHover;
                }}
                onMouseLeave={(e) => {
                  if (!active) e.currentTarget.style.background = "transparent";
                }}
              >
                <Icon size={14} strokeWidth={2} />
                {label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 md:px-8 py-5">
        {tab === "appearance" && <AppearanceTab />}
        {tab === "agents" && <AgentsScreen embedded />}
        {tab === "api" && <ModelsProvidersTab />}
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

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5">
      <section>
        <SectionTitle>Mode</SectionTitle>
        <div
          className="relative grid w-full max-w-[320px] grid-cols-2 gap-1.5 rounded-[14px] p-1"
          style={{ background: styles.toggleTrack, border: bdr("1px", styles.borderSubtle) }}
        >
          <div
            className="absolute bottom-1 top-1 w-[calc(50%-6px)] rounded-[10px] transition-all duration-300"
            style={{ left: mode === "dark" ? "calc(50% + 2px)" : "4px", background: styles.toggleActive }}
          />
          {(["light", "dark"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className="relative z-10 h-9 cursor-pointer rounded-[10px] border-none bg-transparent text-[13px] font-bold capitalize"
              style={{ color: mode === m ? styles.text : styles.textTertiary }}
            >
              {m}
            </button>
          ))}
        </div>
      </section>

      <section>
        <SectionTitle>Theme</SectionTitle>
        <div className="flex flex-col gap-2">
          {THEMES.map((t) => {
            const selected = t.id === themeId;
            const colors = mode === "dark" ? t.paletteDark : t.paletteLight;
            return (
              <button
                key={t.id}
                onClick={() => setTheme(t.id)}
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
                  style={{ background: t.accent, borderColor: styles.border, color: styles.accentText }}
                >
                  Aa
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-bold" style={{ color: styles.text }}>
                    {t.name}
                  </span>
                  <span className="mt-1 flex gap-[3px]">
                    {colors.map((c, i) => (
                      <span
                        key={i}
                        className="h-[14px] w-[14px] rounded-[5px] border"
                        style={{ background: c, borderColor: styles.borderSubtle }}
                      />
                    ))}
                  </span>
                </span>
                {selected ? (
                  <span
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-[12px]"
                    style={{ background: styles.accent, color: styles.accentText }}
                  >
                    ✓
                  </span>
                ) : null}
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

/* ── API & Providers ────────────────────────────────────── */

export function ApiTab() {
  const styles = useThemeStyles();
  const queryClient = useQueryClient();
  const providersQuery = useQuery({
    queryKey: ["settings.providers"],
    queryFn: fetchProviders,
    staleTime: 30_000,
  });
  const options = useMemo(
    () => withClientDefaults(providersQuery.data ?? []),
    [providersQuery.data],
  );

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <p className="text-[12px] leading-relaxed" style={{ color: styles.textSecondary }}>
        Keys are stored ONLY in Windows Credential Manager (DPAPI) and pushed to the local
        agent core — never in the database, never in logs.
      </p>
      {providersQuery.isError ? (
        <div
          role="alert"
          className="rounded-lg border-[1.5px] px-3 py-2 text-[11px]"
          style={{ borderColor: withAlpha("#D64545", 0.4), color: "#D64545" }}
        >
          Agent core unreachable — run the app (or <code>pnpm dev:full</code>) to configure keys.
        </div>
      ) : null}
      {options.map(({ provider }) => (
        <ProviderKeyCard
          key={provider.id}
          providerId={provider.id}
          name={provider.name}
          baseUrl={provider.baseUrl}
          hasKey={provider.hasKey}
          onKeyStored={() =>
            void queryClient.invalidateQueries({ queryKey: ["settings.providers"] })
          }
        />
      ))}
    </div>
  );
}

function ProviderKeyCard({
  providerId,
  name,
  baseUrl,
  hasKey,
  onKeyStored,
}: {
  providerId: string;
  name: string;
  baseUrl: string | null;
  hasKey: boolean;
  onKeyStored: () => void;
}) {
  const styles = useThemeStyles();
  const [key, setKey] = useState("");
  const [model, setModel] = useState(providerId === "openrouter" ? "stealth/ox-alpha" : "");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ConnectionTestResult | null>(null);

  const saveKey = async () => {
    if (key.trim().length <= 6 || saving) return;
    setSaving(true);
    try {
      if (isTauri()) {
        await storeProviderKey(providerId, key.trim());
        onKeyStored();
      }
      setKey("");
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    if (testing) return;
    setTesting(true);
    setResult(null);
    try {
      if (isTauri() && key.trim().length > 6) {
        await storeProviderKey(providerId, key.trim());
        onKeyStored();
      }
      setResult(await testConnection(providerId, model.trim() || undefined));
    } finally {
      setTesting(false);
    }
  };

  const inputStyle = {
    background: styles.inputBg,
    borderColor: styles.inputBorder,
    color: styles.text,
  } as const;

  return (
    <div
      className="rounded-[16px] border-[1.5px] p-4"
      style={{ background: styles.card, borderColor: styles.border }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-[11px] font-bold"
              style={{ background: styles.accent, color: styles.accentText }}
            >
              {name.charAt(0).toUpperCase()}
            </span>
            <span className="text-[14px] font-bold" style={{ color: styles.text }}>
              {name}
            </span>
          </div>
          {baseUrl ? (
            <div className="mt-1 truncate font-mono text-[10px]" style={{ color: styles.textTertiary }}>
              {baseUrl}
            </div>
          ) : null}
        </div>
        <span
          className="rounded-full border px-2 py-0.5 text-[10px] font-bold"
          style={{
            background: hasKey ? withAlpha("#27C93F", 0.12) : styles.subtle,
            borderColor: hasKey ? withAlpha("#27C93F", 0.4) : styles.border,
            color: hasKey ? "#27C93F" : styles.textTertiary,
          }}
        >
          {hasKey ? "● key stored" : "no key"}
        </span>
      </div>

      <div className="mt-3 grid gap-2 md:grid-cols-2">
        <div>
          <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest" style={{ color: styles.textTertiary }}>
            API key
          </label>
          <input
            type="password"
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={hasKey ? "•••• stored — type to replace" : "sk-..."}
            className="h-10 w-full rounded-[10px] border-[1.5px] px-3 font-mono text-[12px] outline-none"
            style={inputStyle}
          />
        </div>
        <div>
          <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest" style={{ color: styles.textTertiary }}>
            Test model
          </label>
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="provider/model"
            className="h-10 w-full rounded-[10px] border-[1.5px] px-3 font-mono text-[12px] outline-none"
            style={inputStyle}
          />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          onClick={() => void saveKey()}
          disabled={key.trim().length <= 6 || saving || !isTauri()}
          title={isTauri() ? "Store in Windows Credential Manager" : "Key storage requires the desktop app"}
        >
          {saving ? "Storing…" : "Store key"}
        </Button>
        <Button variant="outline" onClick={() => void runTest()} disabled={testing || (!hasKey && key.trim().length <= 6)}>
          {testing ? "Testing…" : "Test connection"}
        </Button>
        {result ? (
          <span
            className="min-w-0 truncate text-[11px] font-medium"
            style={{ color: result.ok ? styles.textSecondary : "#D64545" }}
            title={result.message}
          >
            {result.ok
              ? `Connected${result.latencyMs ? ` • ${result.latencyMs}ms` : ""}${result.model ? ` • ${result.model}` : ""}${!isTauri() ? " • server key" : ""}`
              : (result.message ?? "Test failed.")}
          </span>
        ) : null}
        {!isTauri() ? (
          <span className="text-[10px]" style={{ color: styles.textTertiary }}>
            browser dev: tests the key held server-side
          </span>
        ) : null}
      </div>
    </div>
  );
}

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
