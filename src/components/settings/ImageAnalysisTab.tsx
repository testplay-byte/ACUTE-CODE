import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Eye, EyeOff, ScanEye } from "lucide-react";
import { useTimeoutClear } from "../../hooks/use-timeout-clear";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { isTauri } from "../../lib/sidecar";
import { withAlpha } from "../dashboard/helpers";
// R100-E2: the round-100 primitives + the semantic status home (the local
// AMBER const and the inline status hexes retired — TOKENS.md §7).
import { Kicker } from "../ui/Kicker";
import { SectionCard } from "../ui/SectionCard";
import { SEMANTIC_COLORS } from "../../lib/semantics";
import { ClampedText } from "../shared/ClampedText";
import {
  clearVisionKey,
  fetchModelsCatalog,
  fetchProviderModelConfig,
  fetchProviders,
  fetchVisionKey,
  fetchVisionSettings,
  setVisionKey,
  updateProviderModelConfig,
  updateVisionSettings,
  type ProviderModelConfig,
  type ProviderView,
  type VisionSettings,
} from "../../lib/api";

/**
 * ROUND-61 close-out: the Tauri shell's window global shape (the same
 * minimal contract onboarding/providers-api.ts declares — kept local so
 * this tab doesn't widen anyone's public surface).
 */
interface TauriGlobal {
  core: {
    // R102-A: generic like the providers-api bridge — the key-store commands
    // resolve with their report payloads.
    invoke: <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;
  };
}

/**
 * ROUND-66 (R66-2-b): the PACKAGED app stores the vision key DURABLY via the
 * shell's store_vision_key command (OS credential store + spawn-time env
 * injection ACUTE_PROVIDER_<ID>_VISION + a live push into the running
 * engine's keyring) — the REST route only writes the in-memory keyring and
 * would be lost on an engine restart. Web/dev mode (no shell) uses the REST
 * route. The EXACT storeProviderKey/storeVisionKeyDurable pattern from the
 * R61 ComputerUseTab (kept verbatim — the command args are {providerId,
 * key}: the shell maps them to the "<providerId>-vision" slot).
 */
async function storeVisionKeyDurable(
  providerId: string,
  key: string,
): Promise<{ store: "credential-manager" | "secret-service" | "key-file"; note?: string | null } | null> {
  if (!isTauri()) return null;
  const shell = (window as { __TAURI__?: TauriGlobal }).__TAURI__;
  if (!shell) throw new Error("Tauri shell unavailable");
  // R102-A: the command returns the KeyStoreReport (where the key landed +
  // the key-file disclosure note) — the save flow renders the note amber.
  const report = await shell.core.invoke<{ store: string; note?: string | null }>("store_vision_key", {
    providerId,
    key,
  });
  if (report.store === "credential-manager" || report.store === "secret-service") {
    return { store: report.store, note: report.note ?? null };
  }
  if (report.store === "key-file") {
    return { store: "key-file", note: report.note ?? null };
  }
  // An unexpected wire spelling (never happens with the shipped shell, but
  // a stale shell + new UI must degrade honestly, not misreport the store):
  // fall back to the REST route's caller path — the key DID save somewhere.
  return { store: "credential-manager", note: null };
}

/**
 * ImageAnalysisTab — ROUND-66 (R66-2-b, owner directive B3+B5): the DEDICATED
 * image-analysis (vision) section. The vision model was REMOVED from
 * Computer Use and now lives here, app-wide: computer-use screenshots, the
 * embedded browser's screenshots, and the general analyze_image tool all
 * read this ONE configuration.
 *
 * Stacked cards (SubAgentsTab structure, R58-d design language):
 *  (a) Mode — off / separate (recommended) / main radio → PUT /vision/settings.
 *  (b) Separate model (mode="separate") — provider select + model input
 *      (datalist = catalog models that supportVision) + the DEDICATED vision
 *      key row (masked only, Key saved chip, Replace/Clear) riding the SAVED
 *      provider.
 *  (c) Main model (mode="main") — the amber hint + the compact per-provider
 *      model rows with the eye toggle (supportsVision).
 *  (d) Readiness — one honest line from the settings state (mode/provider/
 *      model/key presence). NO test button: a real end-to-end probe needs a
 *      live provider call this tab deliberately doesn't make (the R66 plan
 *      scoped it out — the settings + key presence here are the truth).
 */
const coreUnreachableHint = isTauri()
  ? "agent-core is not responding — if the connection banner is showing, use its Restart engine button, then reopen this tab."
  : "Agent core unreachable — start the app (or pnpm dev:full).";

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
            className="text-[12px] font-medium"
            style={{ color: disabled ? styles.textTertiary : styles.text }}
          >
            {title}
          </span>
          {badge && (
            <span
              className="text-[10px] font-medium uppercase tracking-wider rounded-full px-1.5 py-0.5"
              style={{ background: withAlpha(styles.accent, 0.14), color: styles.accent }}
            >
              {badge}
            </span>
          )}
        </span>
        <span className="text-[11px]" style={{ color: styles.textTertiary }}>
          {description}
        </span>
      </span>
      {selected && <Check size={12} className="shrink-0" style={{ color: styles.accent }} />}
    </button>
  );
}

/* ── Card (a): the mode radio ─────────────────────────────────────────────── */

const VISION_MODES: { id: VisionSettings["mode"]; title: string; description: string; badge?: string }[] = [
  {
    id: "off",
    title: "Off",
    description: "No image is described by any model — every surface reports that honestly.",
  },
  {
    id: "separate",
    title: "Separate model",
    description: "Pick any provider + model + its own API key — completely independent of the chat model.",
    badge: "recommended",
  },
  {
    id: "main",
    title: "Main model",
    description: "Use the agent's model for images when its row is marked supports vision.",
  },
];

function VisionModeCard() {
  const styles = useThemeStyles();
  const queryClient = useQueryClient();
  const resetAfter = useTimeoutClear();
  const [msg, setMsg] = useState<string | null>(null);
  const [msgIsError, setMsgIsError] = useState(false);
  // R102-A: the amber leg — the key-file disclosure (a successful save in
  // the fallback store) must not read as an error.
  const [msgIsWarning, setMsgIsWarning] = useState(false);

  const settingsQuery = useQuery({
    queryKey: ["vision-settings"],
    queryFn: fetchVisionSettings,
  });

  const note = (text: string, isError = false, isWarning = false) => {
    setMsg(text);
    setMsgIsError(isError);
    setMsgIsWarning(isWarning);
    // R102-A: disclosures (warnings) stay up 8s — the key-file note carries
    // actionable text (the path + how to migrate); 1.5s would erase it
    // before it can be read. Errors keep the 1.5s cadence of the notes.
    resetAfter(() => setMsg(null), isWarning ? 8000 : 1500);
  };

  const setMode = useMutation({
    mutationFn: (mode: VisionSettings["mode"]) => updateVisionSettings({ mode }),
    onSuccess: () => {
      note("Mode saved.");
      void queryClient.invalidateQueries({ queryKey: ["vision-settings"] });
    },
    onError: (err: Error) => note(err.message, true),
  });

  if (settingsQuery.isError) {
    return (
      <SectionCard className="p-4" ariaLabel="Image analysis mode">
        <p className="text-[11px]" style={{ color: SEMANTIC_COLORS.danger }} role="alert">
          {coreUnreachableHint} to configure image analysis.
        </p>
      </SectionCard>
    );
  }
  const settings = settingsQuery.data;
  if (settingsQuery.isLoading || settings === undefined) {
    return (
      <SectionCard className="p-4" ariaLabel="Image analysis mode">
        <span className="text-[12px] font-mono" style={{ color: styles.textTertiary }}>
          loading image analysis settings…
        </span>
      </SectionCard>
    );
  }

  return (
    /* R100-E2: the SectionCard primitive (aria-label passthrough). */
    <SectionCard className="p-4 flex flex-col gap-2.5" ariaLabel="Image analysis mode">
      <div className="flex items-center gap-2 flex-wrap">
        <ScanEye size={13} style={{ color: styles.accent, opacity: 0.8 }} />
        <span className="text-[13px] font-semibold" style={{ color: styles.text }}>
          Image analysis
        </span>
        <span className="flex-1" />
        {msg && (
          <span
            className="text-[11px] font-medium"
            style={{
              color: msgIsError
                ? SEMANTIC_COLORS.danger
                : msgIsWarning
                  ? SEMANTIC_COLORS.warning
                  : SEMANTIC_COLORS.success,
            }}
          >
            {msg}
          </span>
        )}
      </div>
      <p className="text-[11px] leading-relaxed" style={{ color: styles.textSecondary }}>
        The vision model that describes what the agent sees — app-wide: computer-use screenshots,
        embedded-browser screenshots, and the general analyze_image tool all read this one
        configuration.
      </p>
      <div
        role="radiogroup"
        aria-label="Image analysis mode"
        className="rounded-lg border-[1.5px] overflow-hidden"
        style={{ borderColor: styles.border }}
      >
        {VISION_MODES.map((m) => (
          <RadioRow
            key={m.id}
            selected={settings.mode === m.id}
            title={m.title}
            description={m.description}
            badge={m.badge}
            onClick={() => setMode.mutate(m.id)}
            ariaLabel={`Image analysis mode: ${m.title}`}
          />
        ))}
      </div>
      {settings.mode === "off" && (
        <p className="text-[11px] leading-relaxed" style={{ color: styles.textTertiary }}>
          Off means no model ever sees an image. Turning it on gives: screenshot descriptions in
          computer use, screenshot descriptions in the embedded browser, and the general
          analyze_image tool (any local file or http(s) image URL) — no computer use needed.
        </p>
      )}
      {settings.mode === "separate" && (
        <SeparateModelCard
          key={`${settings.provider ?? "-"}|${settings.modelId ?? "-"}`}
          settings={settings}
          onNote={note}
        />
      )}
      {settings.mode === "main" && <MainModelCard onNote={note} />}
    </SectionCard>
  );
}

/* ── Card (b): the separate model + its dedicated key ────────────────────── */

/**
 * "separate" mode: provider + model + the dedicated vision key row. Mounted
 * keyed on the SAVED pair so drafts re-initialize after each save. The KEY
 * row rides the SAVED provider (its own dedicated slot, never the
 * provider's primary key).
 */
function SeparateModelCard({
  settings,
  onNote,
}: {
  settings: VisionSettings;
  onNote: (text: string, isError?: boolean, isWarning?: boolean) => void;
}) {
  const styles = useThemeStyles();
  const queryClient = useQueryClient();
  const [provider, setProvider] = useState<string | null>(settings.provider);
  const [modelId, setModelId] = useState(settings.modelId ?? "");
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

  // The key row rides the SAVED provider (the one "Save model" persisted).
  const savedProvider = settings.provider;
  const visionKeyQuery = useQuery({
    queryKey: ["vision-key", savedProvider],
    queryFn: () => fetchVisionKey(savedProvider as string),
    enabled: savedProvider !== null,
  });

  const saveModel = useMutation({
    mutationFn: () =>
      updateVisionSettings({
        provider,
        modelId: modelId.trim() || null,
      }),
    onSuccess: () => {
      onNote("Vision model saved.");
      void queryClient.invalidateQueries({ queryKey: ["vision-settings"] });
    },
    onError: (err: Error) => onNote(err.message, true),
  });

  const saveKey = useMutation({
    // Tauri-first durability — the packaged app writes the OS credential
    // store via store_vision_key (which ALSO pushes the key into the running
    // engine, so the REST keyring query sees it); web/dev mode falls back to
    // the REST in-memory route.
    // R102-A: the shell returns the KeyStoreReport — a key-file save (the
    // Linux fallback, no reachable Secret Service) discloses its note in
    // amber instead of the plain green confirmation.
    mutationFn: async () => {
      const report = await storeVisionKeyDurable(savedProvider as string, keyDraft.trim());
      if (!report) {
        await setVisionKey(savedProvider as string, keyDraft.trim());
        return null;
      }
      return report;
    },
    onSuccess: (report) => {
      if (report?.store === "key-file") {
        onNote(
          report.note ??
            "Vision key saved to the local key file — no Secret Service keyring was reachable.",
          false,
          true,
        );
      } else {
        onNote("Vision key saved.");
      }
      setKeyDraft("");
      setReplacing(false);
      void queryClient.invalidateQueries({ queryKey: ["vision-key", savedProvider] });
    },
    onError: (err: Error) => onNote(err.message, true),
  });

  const clearKey = useMutation({
    mutationFn: () => clearVisionKey(savedProvider as string),
    onSuccess: () => {
      onNote("Vision key cleared.");
      setReplacing(false);
      void queryClient.invalidateQueries({ queryKey: ["vision-key", savedProvider] });
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
    provider !== settings.provider || modelId.trim() !== (settings.modelId ?? "");
  const keyInfo = visionKeyQuery.data;

  return (
    <div className="flex flex-col gap-2.5" data-testid="separate-vision-card">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[11px] font-medium shrink-0" style={{ color: styles.textSecondary }}>
          Provider
        </span>
        <select
          value={provider ?? ""}
          onChange={(e) => {
            setProvider(e.target.value === "" ? null : e.target.value);
            setReplacing(false);
          }}
          aria-label="Vision provider"
          className="h-8 rounded-lg border-[1.5px] px-2 text-[11px] outline-none"
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
        <span className="text-[11px] font-medium shrink-0" style={{ color: styles.textSecondary }}>
          Model
        </span>
        <input
          list="vision-model-options"
          value={modelId}
          onChange={(e) => setModelId(e.target.value)}
          placeholder="provider/model or free-text id"
          aria-label="Vision model id"
          className="h-8 flex-1 min-w-[200px] rounded-lg border-[1.5px] px-2.5 font-mono text-[11px] outline-none"
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
          className="h-8 px-3 rounded-lg text-[11px] font-medium shrink-0 disabled:opacity-50"
          style={{ background: withAlpha(styles.accent, 0.12), color: styles.accent }}
        >
          {saveModel.isPending ? "Saving…" : "Save model"}
        </button>
      </div>
      <p className="text-[11px]" style={{ color: styles.textTertiary }}>
        {visionModels.length > 0
          ? `${visionModels.length} catalog models support images (the datalist); any id can be typed.`
          : "The model is a free-text id — the catalog is unavailable right now."}
      </p>

      {/* The dedicated vision key row — rides the SAVED provider. */}
      {savedProvider === null ? (
        <p className="text-[11px]" style={{ color: styles.textTertiary }}>
          Save a provider first — its dedicated vision key slot rides the saved provider id.
        </p>
      ) : visionKeyQuery.isLoading ? (
        <span className="text-[11px] font-mono" style={{ color: styles.textTertiary }}>
          checking the vision key…
        </span>
      ) : (
        <div
          className="flex items-center gap-2 flex-wrap rounded-lg border-[1.5px] px-3 py-2"
          style={{ borderColor: styles.border, background: withAlpha(styles.accent, 0.03) }}
          data-testid="vision-key-row"
        >
          <span className="text-[11px] font-medium shrink-0" style={{ color: styles.textTertiary }}>
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
                className="text-[10px] font-medium uppercase tracking-wider rounded-full px-1.5 py-0.5 shrink-0"
                style={{ background: withAlpha(SEMANTIC_COLORS.success, 0.12), color: SEMANTIC_COLORS.success }}
              >
                Key saved
              </span>
              {replacing ? (
                <input
                  type="password"
                  autoComplete="off"
                  value={keyDraft}
                  onChange={(e) => setKeyDraft(e.target.value)}
                  placeholder={`paste the replacement key for ${savedProvider}`}
                  aria-label={`Replacement vision key for ${savedProvider}`}
                  className="h-8 flex-1 min-w-[180px] rounded-lg border-[1.5px] px-2.5 font-mono text-[11px] outline-none"
                  style={inputStyle}
                />
              ) : null}
              <button
                onClick={() => setReplacing((v) => !v)}
                aria-label={`Replace vision key for ${savedProvider}`}
                className="h-8 px-2.5 rounded-lg text-[11px] font-medium shrink-0"
                style={{ background: styles.subtle, color: styles.textSecondary }}
              >
                {replacing ? "Hide" : "Replace"}
              </button>
              {replacing && (
                <button
                  onClick={() => keyDraft.trim() && saveKey.mutate()}
                  disabled={!keyDraft.trim() || saveKey.isPending}
                  aria-label={`Save vision key for ${savedProvider}`}
                  className="h-8 px-2.5 rounded-lg text-[11px] font-medium shrink-0 disabled:opacity-50"
                  style={{ background: withAlpha(styles.accent, 0.12), color: styles.accent }}
                >
                  {saveKey.isPending ? "Saving…" : "Save"}
                </button>
              )}
              <button
                onClick={() => clearKey.mutate()}
                disabled={clearKey.isPending}
                aria-label={`Clear vision key for ${savedProvider}`}
                className="h-8 px-2.5 rounded-lg text-[11px] font-medium shrink-0 disabled:opacity-50"
                style={{ background: withAlpha(SEMANTIC_COLORS.danger, 0.1), color: SEMANTIC_COLORS.danger }}
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
                placeholder={`paste ${savedProvider}'s dedicated vision key`}
                aria-label={`Vision key for ${savedProvider}`}
                className="h-8 flex-1 min-w-[180px] rounded-lg border-[1.5px] px-2.5 font-mono text-[11px] outline-none"
                style={inputStyle}
              />
              <button
                onClick={() => keyDraft.trim() && saveKey.mutate()}
                disabled={!keyDraft.trim() || saveKey.isPending}
                aria-label={`Save vision key for ${savedProvider}`}
                className="h-8 px-2.5 rounded-lg text-[11px] font-medium shrink-0 disabled:opacity-50"
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

/* ── Card (c): the main-mode model rows ───────────────────────────────────── */

/** One configured model row in "main" mode — the eye toggles supportsVision. */
function VisionModelRow({
  provider,
  model,
  onNote,
}: {
  provider: ProviderView;
  model: ProviderModelConfig;
  onNote: (text: string, isError?: boolean, isWarning?: boolean) => void;
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
          color: model.supportsVision ? SEMANTIC_COLORS.success : styles.textTertiary,
          background: model.supportsVision ? withAlpha(SEMANTIC_COLORS.success, 0.1) : "transparent",
        }}
      >
        {model.supportsVision ? <Eye size={13} /> : <EyeOff size={13} />}
      </button>
      <span className="min-w-0 flex-1 flex items-baseline gap-1.5">
        <ClampedText
          text={model.displayName || model.modelId}
          lines={1}
          className="text-[12px] font-medium"
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
        className="text-[10px] font-medium uppercase tracking-wider rounded-full px-1.5 py-0.5 shrink-0"
        style={{
          background: model.supportsVision ? withAlpha(SEMANTIC_COLORS.success, 0.12) : styles.subtle,
          color: model.supportsVision ? SEMANTIC_COLORS.success : styles.textTertiary,
        }}
      >
        {model.supportsVision ? "supports vision" : "no images"}
      </span>
    </div>
  );
}

/** "main" mode: the hint + the compact configured-models list. */
function MainModelCard({ onNote }: { onNote: (text: string, isError?: boolean) => void }) {
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
        className="rounded-lg border-[1.5px] px-3 py-2.5"
        style={{ borderColor: withAlpha(SEMANTIC_COLORS.warning, 0.4), background: withAlpha(SEMANTIC_COLORS.warning, 0.04) }}
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
        <p className="text-[11px]" style={{ color: SEMANTIC_COLORS.danger }} role="alert">
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
          className="rounded-lg border-[1.5px] overflow-hidden max-h-64 overflow-y-auto"
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

/* ── Card (d): the honest readiness line (no test button — see header) ────── */

function ReadinessCard() {
  const styles = useThemeStyles();
  const settingsQuery = useQuery({
    queryKey: ["vision-settings"],
    queryFn: fetchVisionSettings,
  });
  const settings = settingsQuery.data;
  // Key presence rides the same query the key row uses (shared cache).
  const keyQuery = useQuery({
    queryKey: ["vision-key", settings?.provider ?? null],
    queryFn: () => fetchVisionKey(settings?.provider as string),
    enabled: settings?.mode === "separate" && settings.provider !== null,
  });

  if (settings === undefined) return null;
  const keySaved = keyQuery.data?.hasKey === true;

  let line: string;
  let ready = false;
  if (settings.mode === "off") {
    line = "Off — no model analyzes any image.";
  } else if (settings.mode === "separate") {
    if (settings.provider === null || settings.modelId === null) {
      line = "Separate model picked — but no provider/model is saved yet.";
    } else if (keySaved) {
      ready = true;
      line = `Separate model · ${settings.provider}/${settings.modelId} · dedicated key saved.`;
    } else {
      line = `Separate model · ${settings.provider}/${settings.modelId} · no dedicated key yet (the provider's primary key is the fallback).`;
    }
  } else {
    line = "Main model · the turn's model describes images only when its row is marked supports vision (toggle it above).";
  }

  return (
    <section
      className="rounded-2xl border-[1.5px] p-4 flex items-start gap-2.5"
      style={{
        background: withAlpha(ready ? SEMANTIC_COLORS.success : styles.text, 0.02),
        borderColor: styles.borderSubtle,
      }}
      aria-label="Image analysis readiness"
      data-testid="vision-readiness"
    >
      <span
        className="text-[10px] font-medium uppercase tracking-wider rounded-full px-2 py-0.5 shrink-0 mt-0.5"
        style={{
          background: ready ? withAlpha(SEMANTIC_COLORS.success, 0.12) : styles.subtle,
          color: ready ? SEMANTIC_COLORS.success : styles.textTertiary,
        }}
      >
        Readiness
      </span>
      <p className="text-[11px] leading-relaxed" style={{ color: styles.textTertiary }}>
        {line}
      </p>
    </section>
  );
}

/* ── Composition ──────────────────────────────────────────────────────────── */

/** The dedicated Image analysis settings tab (R66: ?tab=imageanalysis). */
export function ImageAnalysisTab() {
  const styles = useThemeStyles();
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <div className="pb-1">
        {/* R100-E2: the tab-intro header snapped to the E1 grammar — Kicker
            (the nav group) + 13px/600 title + 12px secondary description. */}
        <Kicker className="mb-1">Integrations</Kicker>
        <h2 className="text-[13px] font-semibold text-ink">Image analysis</h2>
        <p className="mt-1 text-[12px]" style={{ color: styles.textSecondary }}>
          The vision model, in its own section: the provider and model that describes every image
          the agent sees — computer-use screenshots, browser screenshots, and the general
          analyze_image tool.
        </p>
      </div>
      <VisionModeCard />
      <ReadinessCard />
    </div>
  );
}

export default ImageAnalysisTab;
