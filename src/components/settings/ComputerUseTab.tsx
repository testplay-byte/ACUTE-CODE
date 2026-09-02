import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Eye, EyeOff, Monitor, ShieldAlert } from "lucide-react";
import { useTimeoutClear } from "../../hooks/use-timeout-clear";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { isTauri } from "../../lib/sidecar";
import { withAlpha } from "../dashboard/helpers";
import { ClampedText } from "../shared/ClampedText";
import {
  clearVisionKey,
  fetchComputerUseConfig,
  fetchModelsCatalog,
  fetchProviderModelConfig,
  fetchProviders,
  fetchVisionKey,
  setVisionKey,
  testComputerUse,
  updateComputerUseConfig,
  updateProviderModelConfig,
  type ComputerUsePosture,
  type ComputerUseSettings,
  type ComputerVisionMode,
  type ComputerUseConfigResponse,
  type ProviderModelConfig,
  type ProviderView,
} from "../../lib/api";

/**
 * ROUND-61 close-out: the Tauri shell's window global shape (the same
 * minimal contract onboarding/providers-api.ts declares — kept local so
 * this tab doesn't widen anyone's public surface).
 */
interface TauriGlobal {
  core: {
    invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
}

/**
 * ROUND-61 close-out: the PACKAGED app stores the vision key DURABLY via the
 * shell's store_vision_key command (OS credential store + spawn-time env
 * injection ACUTE_PROVIDER_<ID>_VISION + a live push into the running
 * engine's keyring) — the REST route only writes the in-memory keyring and
 * would be lost on an engine restart. Web/dev mode (no shell) uses the REST
 * route. Mirrors the storeProviderKey pattern from the onboarding flow.
 */
async function storeVisionKeyDurable(providerId: string, key: string): Promise<boolean> {
  if (!isTauri()) return false;
  const shell = (window as { __TAURI__?: TauriGlobal }).__TAURI__;
  if (!shell) throw new Error("Tauri shell unavailable");
  await shell.core.invoke("store_vision_key", { providerId, key });
  return true;
}

/**
 * ComputerUseTab — ROUND-61 (R61-2-a): the R61 CENTERPIECE — the owner's
 * master switch for host control, plus the vision-model separation.
 *
 * Three stacked cards (SubAgentsTab structure):
 *  (a) Computer use — the master switch (optimistic PUT /computer-use/config
 *      {enabled}), the posture radio (observe / act / auto) while ON, the
 *      platform + capability report, and the Test readiness probe
 *      (POST /computer-use/test).
 *  (b) Vision model — the separation mode radio (off / separate / main);
 *      "separate" exposes provider + model + the DEDICATED vision key row
 *      (GET/PUT/DELETE /computer-use/vision-key); "main" shows the
 *      supports-vision state of every configured model row with the eye
 *      toggle (PATCH /models/:id {supportsVision}).
 *  (c) Safety note — the honest defaults (OFF; STOP lives in the monitor).
 *
 * Design mirrors SubAgentsTab (R58-d): theme system, useQuery/useMutation +
 * invalidation, useTimeoutClear toasts, mode-aware coreUnreachableHint.
 */
const coreUnreachableHint = isTauri()
  ? "agent-core is not responding — if the connection banner is showing, use its Restart engine button, then reopen this tab."
  : "Agent core unreachable — start the app (or pnpm dev:full).";

const AMBER = "#f59e0b";

/** The card's own toggle (same track/thumb markup as ModelsProvidersTab). */
function ToggleSwitch({
  checked,
  onToggle,
  label,
  title,
  disabled,
  big,
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
  title?: string;
  disabled?: boolean;
  big?: boolean;
}) {
  const styles = useThemeStyles();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={onToggle}
      className={`${
        big ? "h-7 w-[52px]" : "h-6 w-11"
      } relative shrink-0 cursor-pointer rounded-full transition-colors disabled:cursor-wait disabled:opacity-60`}
      style={{
        background: checked ? styles.accent : withAlpha(styles.text, 0.18),
        border: `1.5px solid ${checked ? styles.accent : styles.border}`,
      }}
    >
      <span
        className="absolute top-1/2 block rounded-full bg-white shadow transition-all"
        style={{
          left: checked ? "calc(100% - 25px)" : "3px",
          height: 21,
          width: 21,
          transform: "translateY(-50%)",
        }}
      />
    </button>
  );
}

/** A radio row (title + description) in the SubAgentsTab picker style. */
function RadioRow({
  selected,
  disabled,
  title,
  description,
  badge,
  onClick,
  ariaLabel,
}: {
  selected: boolean;
  disabled?: boolean;
  title: string;
  description: string;
  badge?: string;
  onClick: () => void;
  ariaLabel: string;
}) {
  const styles = useThemeStyles();
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      role="radio"
      aria-checked={selected}
      aria-label={ariaLabel}
      className="w-full flex items-center gap-2 px-3 py-2 border-b last:border-b-0 text-left disabled:cursor-not-allowed"
      style={{
        borderColor: styles.borderSubtle,
        background: selected ? withAlpha(styles.accent, 0.07) : "transparent",
        opacity: disabled ? 0.55 : 1,
      }}
    >
      <span className="min-w-0 flex-1 flex flex-col gap-0.5">
        <span className="flex items-center gap-1.5 flex-wrap">
          <span
            className="text-[12px] font-bold"
            style={{ color: disabled ? styles.textTertiary : styles.text }}
          >
            {title}
          </span>
          {badge && (
            <span
              className="text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5"
              style={{ background: withAlpha(styles.accent, 0.14), color: styles.accent }}
            >
              {badge}
            </span>
          )}
        </span>
        <span className="text-[10.5px]" style={{ color: styles.textTertiary }}>
          {description}
        </span>
      </span>
      {selected && <Check size={12} className="shrink-0" style={{ color: styles.accent }} />}
    </button>
  );
}

/* ── Card (a): the master switch + posture + platform + readiness ─────────── */

const POSTURES: { id: ComputerUsePosture; title: string; description: string; badge?: string }[] = [
  {
    id: "observe",
    title: "Observe only",
    description: "The agent can look (apps, windows, accessibility tree, screenshots) but never act.",
  },
  {
    id: "act",
    title: "Act with approval",
    description: "Mutating actions ask first.",
    badge: "recommended",
  },
  {
    id: "auto",
    title: "Autopilot",
    description: "No per-action prompts — every action fires without asking.",
  },
];

function ComputerUseMasterCard() {
  const styles = useThemeStyles();
  const queryClient = useQueryClient();
  const resetAfter = useTimeoutClear();
  const [msg, setMsg] = useState<string | null>(null);
  const [msgIsError, setMsgIsError] = useState(false);
  const [testReport, setTestReport] = useState<{
    ok: boolean;
    issues?: string[];
    [extra: string]: unknown;
  } | null>(null);

  const configQuery = useQuery({
    queryKey: ["computer-use-config"],
    queryFn: fetchComputerUseConfig,
  });

  const note = (text: string, isError = false) => {
    setMsg(text);
    setMsgIsError(isError);
    resetAfter(() => setMsg(null), 1500);
  };

  // The owner's master switch — OPTIMISTIC: the cache flips immediately, a
  // failure rolls back to the server's truth.
  const toggleEnabled = useMutation({
    mutationFn: (enabled: boolean) => updateComputerUseConfig({ enabled }),
    onMutate: async (enabled) => {
      await queryClient.cancelQueries({ queryKey: ["computer-use-config"] });
      const prev = queryClient.getQueryData<ComputerUseConfigResponse>(["computer-use-config"]);
      if (prev !== undefined) {
        queryClient.setQueryData<ComputerUseConfigResponse>(["computer-use-config"], {
          ...prev,
          settings: { ...prev.settings, enabled },
        });
      }
      return { prev };
    },
    onError: (err: Error, _enabled, ctx) => {
      if (ctx?.prev !== undefined) {
        queryClient.setQueryData<ComputerUseConfigResponse>(["computer-use-config"], ctx.prev);
      }
      note(err.message, true);
    },
    onSuccess: (_data, enabled) => {
      if (enabled) note("Computer use enabled.");
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["computer-use-config"] });
    },
  });

  const setPosture = useMutation({
    mutationFn: (permission: ComputerUsePosture) => updateComputerUseConfig({ permission }),
    onSuccess: () => {
      note("Posture saved.");
      void queryClient.invalidateQueries({ queryKey: ["computer-use-config"] });
    },
    onError: (err: Error) => note(err.message, true),
  });

  const testReadiness = useMutation({
    mutationFn: testComputerUse,
    onSuccess: (resp) => setTestReport(resp.report),
    onError: (err: Error) => note(err.message, true),
  });

  if (configQuery.isError) {
    return (
      <section
        className="rounded-[16px] border-[1.5px] p-4"
        style={{ background: styles.card, borderColor: styles.border }}
        aria-label="Computer use"
      >
        <p className="text-[11px]" style={{ color: "#ef4444" }} role="alert">
          {coreUnreachableHint} to configure computer use.
        </p>
      </section>
    );
  }
  const config = configQuery.data;
  if (configQuery.isLoading || config === undefined) {
    return (
      <section
        className="rounded-[16px] border-[1.5px] p-4"
        style={{ background: styles.card, borderColor: styles.border }}
        aria-label="Computer use"
      >
        <span className="text-[12px] font-mono" style={{ color: styles.textTertiary }}>
          loading computer use settings…
        </span>
      </section>
    );
  }

  const settings: ComputerUseSettings = config.settings;
  const issues = Array.isArray(testReport?.issues) ? (testReport?.issues as string[]) : [];

  return (
    <section
      className="rounded-[16px] border-[1.5px] p-4 flex flex-col gap-2.5"
      style={{ background: styles.card, borderColor: styles.border }}
      aria-label="Computer use"
    >
      <div className="flex items-center gap-2 flex-wrap">
        <Monitor size={13} style={{ color: styles.accent, opacity: 0.8 }} />
        <span className="text-[13px] font-bold" style={{ color: styles.text }}>
          Computer use
        </span>
        <span className="flex-1" />
        {msg && (
          <span
            className="text-[11px] font-bold"
            style={{ color: msgIsError ? "#ef4444" : "#22c55e" }}
          >
            {msg}
          </span>
        )}
        <span className="flex items-center gap-2">
          <span className="text-[11px] font-bold" style={{ color: styles.textSecondary }}>
            {settings.enabled ? "Enabled" : "Disabled"}
          </span>
          <ToggleSwitch
            big
            checked={settings.enabled}
            onToggle={() => toggleEnabled.mutate(!settings.enabled)}
            label="Toggle computer use"
            title={
              settings.enabled
                ? "Turn computer use off — the consent gate closes for every agent"
                : "Turn computer use on — the agent may observe (and act, per the posture) this host"
            }
            disabled={toggleEnabled.isPending}
          />
        </span>
      </div>
      <p className="text-[11px] leading-relaxed" style={{ color: styles.textSecondary }}>
        The master switch for host control. When on, the agent gains the computer-use tools and the
        posture below decides how far it may go.
      </p>

      {/* Posture radio — only meaningful while the master switch is ON. */}
      {settings.enabled ? (
        <div
          role="radiogroup"
          aria-label="Computer use posture"
          className="rounded-[10px] border-[1.5px] overflow-hidden"
          style={{ borderColor: styles.border }}
        >
          {POSTURES.map((p) => (
            <RadioRow
              key={p.id}
              selected={settings.permission === p.id}
              title={p.title}
              description={p.description}
              badge={p.badge}
              onClick={() => setPosture.mutate(p.id)}
              ariaLabel={`Posture: ${p.title}`}
            />
          ))}
        </div>
      ) : (
        <p className="text-[10.5px]" style={{ color: styles.textTertiary }}>
          Posture is set while computer use is on — flip the switch to choose observe / act /
          autopilot.
        </p>
      )}

      {/* Platform + capabilities (the backend's own report). */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="font-mono text-[10.5px] shrink-0" style={{ color: styles.textTertiary }}>
          backend: {config.platform}
        </span>
        {Object.entries(config.capabilities ?? {}).map(([key, ok]) => (
          <span
            key={key}
            className="text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5"
            title={ok ? "available on this backend" : "not available on this backend"}
            style={{
              background: ok ? withAlpha("#22c55e", 0.12) : styles.subtle,
              color: ok ? "#22c55e" : styles.textTertiary,
            }}
          >
            {key}
          </span>
        ))}
      </div>

      {/* Readiness probe */}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={() => testReadiness.mutate()}
          disabled={testReadiness.isPending}
          aria-label="Test computer use readiness"
          className="h-8 px-3 rounded-[8px] text-[11px] font-bold shrink-0 disabled:opacity-50"
          style={{ background: withAlpha(styles.accent, 0.12), color: styles.accent }}
        >
          {testReadiness.isPending ? "Testing…" : "Test readiness"}
        </button>
        <span className="text-[10.5px] flex-1 min-w-[180px]" style={{ color: styles.textTertiary }}>
          Runs the engine's readiness probe (permissions + capabilities; never pops dialogs).
        </span>
      </div>
      {testReport && (
        <div
          className="rounded-[10px] border-[1.5px] px-3 py-2.5 flex flex-col gap-1.5"
          style={{
            borderColor: testReport.ok ? withAlpha("#22c55e", 0.4) : withAlpha(AMBER, 0.4),
            background: testReport.ok ? withAlpha("#22c55e", 0.04) : withAlpha(AMBER, 0.04),
          }}
          data-testid="readiness-result"
        >
          <div className="flex items-center gap-2">
            <span
              className="text-[11px] font-black uppercase tracking-wider rounded-full px-2 py-0.5"
              style={{
                background: testReport.ok ? withAlpha("#22c55e", 0.14) : withAlpha(AMBER, 0.14),
                color: testReport.ok ? "#22c55e" : AMBER,
              }}
            >
              {testReport.ok ? "Ready" : "Issues"}
            </span>
            <span className="text-[11px]" style={{ color: styles.textSecondary }}>
              {testReport.ok
                ? "The engine reports computer use is ready on this host."
                : issues.length > 0
                  ? "The readiness probe reported problems:"
                  : "The readiness probe reported problems — see the engine log for details."}
            </span>
          </div>
          {issues.length > 0 && (
            <ul className="flex flex-col gap-1 m-0 pl-4">
              {issues.map((line, i) => (
                <li
                  key={i}
                  className="text-[10.5px] leading-relaxed list-disc"
                  style={{ color: styles.textSecondary }}
                >
                  {line}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

/* ── Card (b): the vision model separation ────────────────────────────────── */

const VISION_MODES: { id: ComputerVisionMode; title: string; description: string }[] = [
  {
    id: "off",
    title: "Off",
    description: "Screenshots return metadata only — no model describes them.",
  },
  {
    id: "separate",
    title: "Separate model",
    description: "Pick any provider + model + its own API key.",
  },
  {
    id: "main",
    title: "Main model",
    description: "Use the agent's model for vision when its row is marked supports vision.",
  },
];

/** "separate" mode: provider + model + the dedicated vision key row. Mounted
 * keyed on the SAVED pair so drafts re-initialize after each save. */
function SeparateVisionCard({
  settings,
  onNote,
}: {
  settings: ComputerUseSettings;
  onNote: (text: string, isError?: boolean) => void;
}) {
  const styles = useThemeStyles();
  const queryClient = useQueryClient();
  const [provider, setProvider] = useState<string | null>(settings.vision.provider);
  const [modelId, setModelId] = useState(settings.vision.modelId ?? "");
  const [keyDraft, setKeyDraft] = useState("");
  const [replacing, setReplacing] = useState(false);

  const providersQuery = useQuery({
    queryKey: ["settings-providers"],
    queryFn: fetchProviders,
  });
  const catalogQuery = useQuery({
    queryKey: ["models-catalog"],
    queryFn: fetchModelsCatalog,
    staleTime: 10 * 60 * 1000,
    retry: false,
  });

  // The key row rides the CURRENT draft provider (the one "Save model" will
  // persist) — its own dedicated slot, never the provider's primary key.
  const visionKeyQuery = useQuery({
    queryKey: ["computer-use-vision-key", provider],
    queryFn: () => fetchVisionKey(provider as string),
    enabled: provider !== null,
  });

  const saveModel = useMutation({
    mutationFn: () =>
      updateComputerUseConfig({
        vision: { provider, modelId: modelId.trim() || null },
      }),
    onSuccess: () => {
      onNote("Vision model saved.");
      void queryClient.invalidateQueries({ queryKey: ["computer-use-config"] });
    },
    onError: (err: Error) => onNote(err.message, true),
  });

  const saveKey = useMutation({
    // ROUND-61 close-out: Tauri-first durability — the packaged app writes
    // the OS credential store via store_vision_key (which ALSO pushes the
    // key into the running engine, so the REST keyring query sees it);
    // web/dev mode falls back to the REST in-memory route.
    mutationFn: async () => {
      const usedShell = await storeVisionKeyDurable(provider as string, keyDraft.trim());
      if (!usedShell) {
        await setVisionKey(provider as string, keyDraft.trim());
      }
    },
    onSuccess: () => {
      onNote("Vision key saved.");
      setKeyDraft("");
      setReplacing(false);
      void queryClient.invalidateQueries({ queryKey: ["computer-use-vision-key", provider] });
    },
    onError: (err: Error) => onNote(err.message, true),
  });

  const clearKey = useMutation({
    mutationFn: () => clearVisionKey(provider as string),
    onSuccess: () => {
      onNote("Vision key cleared.");
      setReplacing(false);
      void queryClient.invalidateQueries({ queryKey: ["computer-use-vision-key", provider] });
    },
    onError: (err: Error) => onNote(err.message, true),
  });

  const inputStyle = {
    background: styles.bg,
    borderColor: styles.border,
    color: styles.text,
  };

  const visionModels =
    catalogQuery.data?.models.filter((m) => m.supportsVision) ?? [];
  const dirty =
    provider !== settings.vision.provider || modelId.trim() !== (settings.vision.modelId ?? "");
  const keyInfo = visionKeyQuery.data;

  return (
    <div className="flex flex-col gap-2.5" data-testid="separate-vision-card">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[11px] font-bold shrink-0" style={{ color: styles.textSecondary }}>
          Provider
        </span>
        <select
          value={provider ?? ""}
          onChange={(e) => {
            setProvider(e.target.value === "" ? null : e.target.value);
            setReplacing(false);
          }}
          aria-label="Vision provider"
          className="h-8 rounded-[8px] border-[1.5px] px-2 text-[11.5px] outline-none"
          style={inputStyle}
        >
          <option value="">— pick a provider —</option>
          {(providersQuery.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.enabled ? "" : " (disabled)"}
            </option>
          ))}
        </select>
        <span className="text-[11px] font-bold shrink-0" style={{ color: styles.textSecondary }}>
          Model
        </span>
        <input
          list="vision-model-options"
          value={modelId}
          onChange={(e) => setModelId(e.target.value)}
          placeholder="provider/model or free-text id"
          aria-label="Vision model id"
          className="h-8 flex-1 min-w-[200px] rounded-[8px] border-[1.5px] px-2.5 font-mono text-[11.5px] outline-none"
          style={inputStyle}
        />
        <datalist id="vision-model-options">
          {visionModels.map((m) => (
            <option key={m.modelId} value={m.modelId}>
              {m.displayName}
            </option>
          ))}
        </datalist>
        <button
          onClick={() => saveModel.mutate()}
          disabled={!dirty || saveModel.isPending}
          aria-label="Save vision model"
          className="h-8 px-3 rounded-[8px] text-[11px] font-bold shrink-0 disabled:opacity-50"
          style={{ background: withAlpha(styles.accent, 0.12), color: styles.accent }}
        >
          {saveModel.isPending ? "Saving…" : "Save model"}
        </button>
      </div>
      <p className="text-[10.5px]" style={{ color: styles.textTertiary }}>
        {visionModels.length > 0
          ? `${visionModels.length} catalog models support images (the datalist); any id can be typed.`
          : "The model is a free-text id — the catalog is unavailable right now."}
      </p>

      {/* The dedicated vision key row. */}
      {provider === null ? (
        <p className="text-[11px]" style={{ color: styles.textTertiary }}>
          Pick a provider first — its dedicated vision key slot rides the provider id.
        </p>
      ) : visionKeyQuery.isLoading ? (
        <span className="text-[11px] font-mono" style={{ color: styles.textTertiary }}>
          checking the vision key…
        </span>
      ) : (
        <div
          className="flex items-center gap-2 flex-wrap rounded-[10px] border-[1.5px] px-3 py-2"
          style={{ borderColor: styles.border, background: withAlpha(styles.accent, 0.03) }}
          data-testid="vision-key-row"
        >
          <span className="text-[11px] font-bold shrink-0" style={{ color: styles.textTertiary }}>
            VISION KEY
          </span>
          {keyInfo?.hasKey ? (
            <>
              <span
                className="font-mono text-[11px] min-w-0 truncate"
                style={{ color: styles.textSecondary }}
                title="The dedicated vision key (masked — never shown in full)"
              >
                {keyInfo.masked ?? "••••••"}
              </span>
              <span
                className="text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 shrink-0"
                style={{ background: withAlpha("#22c55e", 0.12), color: "#22c55e" }}
              >
                Key saved
              </span>
              {replacing ? (
                <input
                  type="password"
                  autoComplete="off"
                  value={keyDraft}
                  onChange={(e) => setKeyDraft(e.target.value)}
                  placeholder={`paste the replacement key for ${provider}`}
                  aria-label={`Replacement vision key for ${provider}`}
                  className="h-8 flex-1 min-w-[180px] rounded-[8px] border-[1.5px] px-2.5 font-mono text-[11px] outline-none"
                  style={inputStyle}
                />
              ) : null}
              <button
                onClick={() => setReplacing((v) => !v)}
                aria-label={`Replace vision key for ${provider}`}
                className="h-8 px-2.5 rounded-[8px] text-[11px] font-bold shrink-0"
                style={{ background: styles.subtle, color: styles.textSecondary }}
              >
                {replacing ? "Hide" : "Replace"}
              </button>
              {replacing && (
                <button
                  onClick={() => keyDraft.trim() && saveKey.mutate()}
                  disabled={!keyDraft.trim() || saveKey.isPending}
                  aria-label={`Save vision key for ${provider}`}
                  className="h-8 px-2.5 rounded-[8px] text-[11px] font-bold shrink-0 disabled:opacity-50"
                  style={{ background: withAlpha(styles.accent, 0.12), color: styles.accent }}
                >
                  {saveKey.isPending ? "Saving…" : "Save"}
                </button>
              )}
              <button
                onClick={() => clearKey.mutate()}
                disabled={clearKey.isPending}
                aria-label={`Clear vision key for ${provider}`}
                className="h-8 px-2.5 rounded-[8px] text-[11px] font-bold shrink-0 disabled:opacity-50"
                style={{ background: withAlpha("#ef4444", 0.1), color: "#ef4444" }}
              >
                Clear
              </button>
            </>
          ) : (
            <>
              <input
                type="password"
                autoComplete="off"
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
                placeholder={`paste ${provider}'s dedicated vision key`}
                aria-label={`Vision key for ${provider}`}
                className="h-8 flex-1 min-w-[180px] rounded-[8px] border-[1.5px] px-2.5 font-mono text-[11px] outline-none"
                style={inputStyle}
              />
              <button
                onClick={() => keyDraft.trim() && saveKey.mutate()}
                disabled={!keyDraft.trim() || saveKey.isPending}
                aria-label={`Save vision key for ${provider}`}
                className="h-8 px-2.5 rounded-[8px] text-[11px] font-bold shrink-0 disabled:opacity-50"
                style={{ background: withAlpha(styles.accent, 0.12), color: styles.accent }}
              >
                {saveKey.isPending ? "Saving…" : "Save"}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** One configured model row in "main" mode — the eye toggles supportsVision. */
function VisionModelRow({
  provider,
  model,
  onNote,
}: {
  provider: ProviderView;
  model: ProviderModelConfig;
  onNote: (text: string, isError?: boolean) => void;
}) {
  const styles = useThemeStyles();
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: () => updateProviderModelConfig(model.id, { supportsVision: !model.supportsVision }),
    onSuccess: () => {
      onNote("Vision flag saved.");
      void queryClient.invalidateQueries({ queryKey: ["vision-model-rows"] });
    },
    onError: (err: Error) => onNote(err.message, true),
  });

  return (
    <div
      className="flex items-center gap-2 px-3 py-2 border-b last:border-b-0"
      style={{ borderColor: styles.borderSubtle }}
      data-vision-model-row={model.id}
    >
      <button
        onClick={() => toggle.mutate()}
        disabled={toggle.isPending}
        aria-label={`Toggle supports vision for ${model.modelId}`}
        title={
          model.supportsVision
            ? "supports vision — click to clear the flag"
            : "no image input — click to mark supports vision"
        }
        className="w-7 h-7 grid place-items-center rounded-md shrink-0 disabled:opacity-50"
        style={{
          color: model.supportsVision ? "#22c55e" : styles.textTertiary,
          background: model.supportsVision ? withAlpha("#22c55e", 0.1) : "transparent",
        }}
      >
        {model.supportsVision ? <Eye size={13} /> : <EyeOff size={13} />}
      </button>
      <span className="min-w-0 flex-1 flex items-baseline gap-1.5">
        <ClampedText
          text={model.displayName || model.modelId}
          lines={1}
          className="text-[12px] font-bold"
          style={{ color: styles.text }}
        />
        <span
          className="font-mono text-[10px] shrink-0 truncate"
          style={{ color: styles.textTertiary }}
          title={`${provider.name} · ${model.modelId}`}
        >
          {provider.name}/{model.modelId}
        </span>
      </span>
      <span
        className="text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 shrink-0"
        style={{
          background: model.supportsVision ? withAlpha("#22c55e", 0.12) : styles.subtle,
          color: model.supportsVision ? "#22c55e" : styles.textTertiary,
        }}
      >
        {model.supportsVision ? "supports vision" : "no images"}
      </span>
    </div>
  );
}

/** "main" mode: the hint + the compact configured-models list. */
function MainVisionCard({ onNote }: { onNote: (text: string, isError?: boolean) => void }) {
  const styles = useThemeStyles();
  const rowsQuery = useQuery({
    queryKey: ["vision-model-rows"],
    queryFn: async () => {
      const providers = await fetchProviders();
      const rows = await Promise.all(
        providers.map(async (p) => {
          try {
            const models = await fetchProviderModelConfig(p.id);
            return models.map((m) => ({ provider: p, model: m }));
          } catch {
            return [] as { provider: ProviderView; model: ProviderModelConfig }[];
          }
        }),
      );
      return rows.flat();
    },
  });

  return (
    <div className="flex flex-col gap-2.5" data-testid="main-vision-card">
      <div
        className="rounded-[10px] border-[1.5px] px-3 py-2.5"
        style={{ borderColor: withAlpha(AMBER, 0.4), background: withAlpha(AMBER, 0.04) }}
      >
        <p className="text-[11px] leading-relaxed" style={{ color: styles.textSecondary }}>
          The agent's current model must be marked supports vision. Set that flag on a model row in
          Models&nbsp;&amp;&nbsp;Providers (the eye toggle on a model row) — or flip it right here:
        </p>
      </div>
      {rowsQuery.isLoading ? (
        <span className="text-[11px] font-mono" style={{ color: styles.textTertiary }}>
          listing configured models…
        </span>
      ) : rowsQuery.isError ? (
        <p className="text-[11px]" style={{ color: "#ef4444" }} role="alert">
          {rowsQuery.error instanceof Error
            ? rowsQuery.error.message
            : String(rowsQuery.error)}
        </p>
      ) : (rowsQuery.data ?? []).length === 0 ? (
        <p className="text-[11px]" style={{ color: styles.textTertiary }}>
          No configured model rows yet — add models under Models&nbsp;&amp;&nbsp;Providers first.
        </p>
      ) : (
        <div
          className="rounded-[10px] border-[1.5px] overflow-hidden max-h-64 overflow-y-auto"
          style={{ borderColor: styles.border }}
        >
          {(rowsQuery.data ?? []).map(({ provider, model }) => (
            <VisionModelRow
              key={model.id}
              provider={provider}
              model={model}
              onNote={onNote}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Card (b) wrapper: the mode radio + the mode-specific body. */
function VisionCard() {
  const styles = useThemeStyles();
  const queryClient = useQueryClient();
  const resetAfter = useTimeoutClear();
  const [msg, setMsg] = useState<string | null>(null);
  const [msgIsError, setMsgIsError] = useState(false);

  const configQuery = useQuery({
    queryKey: ["computer-use-config"],
    queryFn: fetchComputerUseConfig,
  });

  const note = (text: string, isError = false) => {
    setMsg(text);
    setMsgIsError(isError);
    resetAfter(() => setMsg(null), 1500);
  };

  const setMode = useMutation({
    mutationFn: (mode: ComputerVisionMode) => updateComputerUseConfig({ vision: { mode } }),
    onSuccess: () => {
      note("Vision mode saved.");
      void queryClient.invalidateQueries({ queryKey: ["computer-use-config"] });
    },
    onError: (err: Error) => note(err.message, true),
  });

  if (configQuery.isError) {
    return (
      <section
        className="rounded-[16px] border-[1.5px] p-4"
        style={{ background: styles.card, borderColor: styles.border }}
        aria-label="Vision model"
      >
        <p className="text-[11px]" style={{ color: "#ef4444" }} role="alert">
          {coreUnreachableHint} to configure the vision model.
        </p>
      </section>
    );
  }
  const config = configQuery.data;
  if (configQuery.isLoading || config === undefined) {
    return (
      <section
        className="rounded-[16px] border-[1.5px] p-4"
        style={{ background: styles.card, borderColor: styles.border }}
        aria-label="Vision model"
      >
        <span className="text-[12px] font-mono" style={{ color: styles.textTertiary }}>
          loading vision settings…
        </span>
      </section>
    );
  }

  const settings = config.settings;

  return (
    <section
      className="rounded-[16px] border-[1.5px] p-4 flex flex-col gap-2.5"
      style={{ background: styles.card, borderColor: styles.border }}
      aria-label="Vision model"
    >
      <div className="flex items-center gap-2 flex-wrap">
        <Eye size={13} style={{ color: styles.accent, opacity: 0.8 }} />
        <span className="text-[13px] font-bold" style={{ color: styles.text }}>
          Vision model
        </span>
        <span className="flex-1" />
        {msg && (
          <span
            className="text-[11px] font-bold"
            style={{ color: msgIsError ? "#ef4444" : "#22c55e" }}
          >
            {msg}
          </span>
        )}
      </div>
      <p className="text-[11px] leading-relaxed" style={{ color: styles.textSecondary }}>
        The model that describes screenshots for the agent. Completely separate from the main
        model — or the main model itself when it supports images.
      </p>
      <div
        role="radiogroup"
        aria-label="Vision mode"
        className="rounded-[10px] border-[1.5px] overflow-hidden"
        style={{ borderColor: styles.border }}
      >
        {VISION_MODES.map((m) => (
          <RadioRow
            key={m.id}
            selected={settings.vision.mode === m.id}
            title={m.title}
            description={m.description}
            onClick={() => setMode.mutate(m.id)}
            ariaLabel={`Vision mode: ${m.title}`}
          />
        ))}
      </div>
      {settings.vision.mode === "separate" && (
        <SeparateVisionCard
          key={`${settings.vision.provider ?? "-"}|${settings.vision.modelId ?? "-"}`}
          settings={settings}
          onNote={note}
        />
      )}
      {settings.vision.mode === "main" && <MainVisionCard onNote={note} />}
    </section>
  );
}

/* ── Card (c): the safety note ─────────────────────────────────────────────── */

function SafetyCard() {
  const styles = useThemeStyles();
  return (
    <section
      className="rounded-[16px] border-[1.5px] p-4 flex items-start gap-2.5"
      style={{ background: withAlpha(styles.text, 0.02), borderColor: styles.borderSubtle }}
      aria-label="Computer use safety"
    >
      <ShieldAlert size={13} className="shrink-0 mt-0.5" style={{ color: styles.textTertiary }} />
      <p className="text-[10.5px] leading-relaxed" style={{ color: styles.textTertiary }}>
        Computer use is OFF by default. When on, the agent observes via the accessibility tree
        first and falls back to screenshots; destructive actions need your approval in Act mode. A
        STOP kill switch lives in the Computer monitor panel (right sidebar).
      </p>
    </section>
  );
}

/* ── Composition ──────────────────────────────────────────────────────────── */

/** The dedicated Computer use settings tab (?tab=computeruse). */
export function ComputerUseTab() {
  const styles = useThemeStyles();
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <div className="pb-1">
        <h2 className="text-[16px] font-black" style={{ color: styles.text }}>
          Computer use
        </h2>
        <p className="mt-1 text-[12px]" style={{ color: styles.textSecondary }}>
          The master switch for host control, the vision model that describes what the agent sees,
          and the safety posture — everything computer-use lives on this one page.
        </p>
      </div>
      <ComputerUseMasterCard />
      <VisionCard />
      <SafetyCard />
    </div>
  );
}

export default ComputerUseTab;
