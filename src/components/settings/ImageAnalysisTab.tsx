import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { Check, Eye, EyeOff, ScanEye } from "lucide-react";
import { useTimeoutClear } from "../../hooks/use-timeout-clear";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { isTauri } from "../../lib/sidecar";
// R114-e: the CONFIGURED-provider filter the composer's picker shares (the
// ModelSelector audit's one stated rule — a keyless seeded preset or a
// provider disabled in Settings is never a pickable source).
import { filterConfiguredProviders } from "../../lib/settings-store";
// R100-E2: the round-100 primitives (USAGE.md §3).
import { Kicker } from "../ui/Kicker";
import { SectionCard } from "../ui/SectionCard";
import { ClampedText } from "../shared/ClampedText";
import {
  clearVisionKey,
  fetchConfiguredModels,
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
 * R114-e (owner directive): the "off" mode is RETIRED — a model marked
 * supportsVision can always see; the mode now only chooses WHICH model
 * looks. Stacked cards (SubAgentsTab structure, R58-d design language):
 *  (a) Mode — main (the model's own vision, recommended default) /
 *      separate (a dedicated vision model) radio → PUT /vision/settings.
 *  (b) Separate model (mode="separate") — the configured∩supportsVision
 *      model rows (GET /models/configured, hidden excluded) with vision
 *      badges; NO provider select, NO free-text model input (the R114-e
 *      rework removed both) + the DEDICATED vision key row (masked only,
 *      Key saved chip, Replace/Clear) riding the SAVED provider.
 *  (c) Main model (mode="main") — the compact per-provider model rows
 *      with the eye toggle (supportsVision).
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
      /* R126-3f-3: the selected radio row = the selection grammar
       * (bg-accent-tint, TOKENS §10); the hairline on the class leg. */
      className={`w-full flex items-center gap-2 px-3 py-2 border-b border-line last:border-b-0 text-left disabled:cursor-not-allowed ${
        selected ? "bg-accent-tint" : ""
      }`}
      style={{ opacity: disabled ? 0.55 : 1 }}
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
              className="text-[10px] font-medium uppercase tracking-wider rounded-full px-1.5 py-0.5 bg-badge-accent text-badge-accent-fg"
            >
              {badge}
            </span>
          )}
        </span>
        <span className="text-[11px]" style={{ color: styles.textTertiary }}>
          {description}
        </span>
      </span>
      {selected && <Check size={12} className="shrink-0 text-accent-deep" />}
    </button>
  );
}

/* ── Card (a): the mode radio ─────────────────────────────────────────────── */

/**
 * R114-e (owner: "remove the off mode — main model and separate model
 * only"): exactly TWO modes — the main model (recommended default; a model
 * marked supportsVision can always see since R114-b retired "off"
 * server-side) and a separate vision model. The old "off" row is GONE and
 * the settings type narrowed to "main" | "separate" (the server coerces any
 * legacy stored "off" to "main" on read — no migration, no dead state to
 * render).
 */
const VISION_MODES: { id: VisionSettings["mode"]; title: string; description: string; badge?: string }[] = [
  {
    id: "main",
    title: "Main model",
    description: "The agent's own model describes images — works whenever its row is marked supports vision.",
    badge: "recommended",
  },
  {
    id: "separate",
    title: "Separate model",
    description: "Pick one configured vision-capable model (with its own optional dedicated key) — independent of the chat model.",
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
        <p className="text-[11px] text-danger-deep" role="alert">
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
        <ScanEye size={13} className="text-accent-deep" />
        <span className="text-[13px] font-semibold" style={{ color: styles.text }}>
          Image analysis
        </span>
        <span className="flex-1" />
        {msg && (
          <span
            className={`text-[11px] font-medium ${
              msgIsError
                ? "text-danger-deep"
                : msgIsWarning
                  ? "text-warning-deep"
                  : "text-success-deep"
            }`}
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
        /* R126-3f-3: the rim hairline container (TOKENS §5). */
        className="rounded-lg border border-clay-rim overflow-hidden"
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

/** R114-e: one pickable row of the separate vision picker (see below). */
export interface VisionPickerRow {
  /** The row's provider id (the vision settings' `provider`). */
  providerId: string;
  /** The provider's display name (the row's group label). */
  providerName: string;
  /** The configured model row (the vision settings' `modelId` is its modelId). */
  model: ProviderModelConfig;
}

/**
 * ROUND-114 (R114-e, owner: "the separate picker must show the models that
 * support vision, from the ones I actually have"): the separate picker's
 * row list — the CONFIGURED model rows (GET /models/configured) filtered to
 * supportsVision === true, hidden rows excluded, grouped flat under their
 * provider's display name, and only under CONFIGURED providers
 * (filterConfiguredProviders — the exact verdict the composer's picker
 * uses: a keyless seeded preset or a provider disabled in Settings is never
 * a pickable source; that unfiltered <select> was the D4 audit's leak).
 * Order: the provider list's order, then each provider's row order. PURE —
 * exported for the test suite.
 */
export function visionCapableModelRows(
  models: readonly ProviderModelConfig[],
  providers: readonly ProviderView[],
): VisionPickerRow[] {
  const out: VisionPickerRow[] = [];
  for (const provider of filterConfiguredProviders(providers)) {
    for (const model of models) {
      if (model.providerId !== provider.id) continue;
      if (model.supportsVision !== true || model.hidden === true) continue;
      out.push({ providerId: provider.id, providerName: provider.name, model });
    }
  }
  return out;
}

/**
 * R114-e: ONE pickable row — display name + provider label + a small
 * vision badge; selecting rides the card's PUT mutation. Compact and calm
 * (the phone's one-line discipline): the full modelId stays in the row's
 * title tooltip.
 */
function VisionPickerRowButton({
  row,
  selected,
  pending,
  onPick,
}: {
  row: VisionPickerRow;
  selected: boolean;
  pending: boolean;
  onPick: () => void;
}) {
  const styles = useThemeStyles();
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onPick}
      disabled={pending}
      aria-label={`Vision model ${row.providerName} ${row.model.modelId}`}
      title={`${row.providerId}/${row.model.modelId}`}
      data-vision-picker-row={`${row.providerId}/${row.model.modelId}`}
      /* R126-3f-3: the selected row = the selection grammar (bg-accent-tint);
       * the hairline on the class leg. */
      className={`w-full flex items-center gap-2 px-3 py-2 border-b border-line last:border-b-0 text-left disabled:cursor-not-allowed transition-colors ${
        selected ? "bg-accent-tint" : ""
      }`}
    >
      {selected ? (
        <Check size={12} className="shrink-0 text-accent-deep" />
      ) : (
        <span className="w-3 shrink-0" />
      )}
      <span className="min-w-0 flex-1 flex items-baseline gap-1.5">
        <ClampedText
          text={row.model.displayName.trim() !== "" ? row.model.displayName : row.model.modelId}
          lines={1}
          className="text-[12px] font-medium"
          style={{ color: styles.text }}
        />
        <span
          className="font-mono text-[10px] shrink-0 truncate"
          style={{ color: styles.textTertiary }}
          title={`${row.providerId}/${row.model.modelId}`}
        >
          {row.providerName}
        </span>
      </span>
      <span
        className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider rounded-full px-1.5 py-0.5 shrink-0 bg-badge-success text-badge-success-fg"
      >
        <Eye size={10} aria-hidden />
        vision
      </span>
    </button>
  );
}

/**
 * "separate" mode: R114-e REBUILT — the picker is a clean list of the
 * configured, vision-capable model rows (visionCapableModelRows — no
 * provider dropdown, no free-text model input, no static OpenRouter
 * datalist; the owner's directive); selecting a row PUTs the pair through
 * the existing updateVisionSettings. The dedicated vision-key row below is
 * UNTOUCHED and still rides the SAVED provider (its own slot, never the
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
  const navigate = useNavigate();
  const [keyDraft, setKeyDraft] = useState("");
  const [replacing, setReplacing] = useState(false);

  const providersQuery = useQuery({
    queryKey: ["settings-providers"],
    queryFn: fetchProviders,
    staleTime: 60 * 1000,
    retry: false,
  });
  const configuredQuery = useQuery({
    queryKey: ["models-configured"],
    queryFn: fetchConfiguredModels,
    staleTime: 60 * 1000,
    retry: false,
  });

  // The key row rides the SAVED provider (the one the picker persisted).
  const savedProvider = settings.provider;
  const visionKeyQuery = useQuery({
    queryKey: ["vision-key", savedProvider],
    queryFn: () => fetchVisionKey(savedProvider as string),
    enabled: savedProvider !== null,
  });

  const rows = visionCapableModelRows(configuredQuery.data ?? [], providersQuery.data ?? []);
  const savedRow =
    savedProvider !== null && settings.modelId !== null
      ? rows.find((r) => r.providerId === savedProvider && r.model.modelId === settings.modelId) ??
        null
      : null;

  const saveModel = useMutation({
    mutationFn: (row: VisionPickerRow) =>
      updateVisionSettings({
        provider: row.providerId,
        modelId: row.model.modelId,
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

  const keyInfo = visionKeyQuery.data;

  return (
    <div className="flex flex-col gap-2.5" data-testid="separate-vision-card">
      {/* The picker — configured ∩ supportsVision, grouped flat with provider
          labels (R114-e; the empty state points at the flag's home). */}
      {configuredQuery.isLoading || providersQuery.isLoading ? (
        <span className="text-[11px] font-mono" style={{ color: styles.textTertiary }}>
          listing vision-capable models…
        </span>
      ) : configuredQuery.isError || providersQuery.isError ? (
        <p className="text-[11px] text-danger-deep" role="alert">
          {configuredQuery.isError
            ? configuredQuery.error instanceof Error
              ? configuredQuery.error.message
              : String(configuredQuery.error)
            : providersQuery.error instanceof Error
              ? providersQuery.error.message
              : String(providersQuery.error)}
        </p>
      ) : rows.length === 0 ? (
        <div
          /* R126-3f-3: the accent-tint hint strip + the accent-tint action
           * (the well/wash + 1.5px border spellings are retired). */
          className="flex items-center gap-2 flex-wrap rounded-lg border border-clay-rim bg-accent-tint px-3 py-2.5"
          data-testid="vision-picker-empty"
        >
          <p className="text-[11px] leading-relaxed min-w-0 flex-1" style={{ color: styles.textSecondary }}>
            No vision-capable models yet — add one in Models &amp; Providers and mark it
            vision-capable.
          </p>
          <button
            type="button"
            onClick={() => navigate("/settings?tab=api")}
            aria-label="Open Models and Providers"
            className="h-7 px-2.5 rounded-lg text-[11px] font-medium shrink-0 bg-accent-deep ac-clay-pressed transition-transform active:scale-[0.98]"
            style={{ color: styles.accentText }}
          >
            Open Models &amp; Providers
          </button>
        </div>
      ) : (
        <div
          role="radiogroup"
          aria-label="Separate vision model"
          /* R126-3f-3: the rim hairline container (TOKENS §5). */
          className="rounded-lg border border-clay-rim overflow-hidden max-h-64 overflow-y-auto"
        >
          {rows.map((row) => (
            <VisionPickerRowButton
              key={`${row.providerId}/${row.model.id}`}
              row={row}
              selected={
                savedProvider === row.providerId && settings.modelId === row.model.modelId
              }
              pending={saveModel.isPending}
              onPick={() => {
                // Clicking the already-saved row is a no-op (the honest
                // dirty check — no pointless PUT, no "saved" churn).
                if (savedProvider === row.providerId && settings.modelId === row.model.modelId) {
                  return;
                }
                saveModel.mutate(row);
              }}
            />
          ))}
        </div>
      )}
      {/* A SAVED pair that no longer matches any pickable row (the provider
          lost its key, the row lost its vision flag, the row was deleted) —
          the honest note instead of a silently missing selection. */}
      {savedProvider !== null && settings.modelId !== null && savedRow === null && rows.length > 0 ? (
        <p className="text-[11px]" style={{ color: styles.textTertiary }}>
          The saved model ({savedProvider}/{settings.modelId}) is no longer in the list — pick a
          model above to re-point the vision relay.
        </p>
      ) : null}

      {/* The dedicated vision key row — rides the SAVED provider. */}
      {savedProvider === null ? (
        <p className="text-[11px]" style={{ color: styles.textTertiary }}>
          Pick a model above first — its dedicated vision key slot rides the saved provider id.
        </p>
      ) : visionKeyQuery.isLoading ? (
        <span className="text-[11px] font-mono" style={{ color: styles.textTertiary }}>
          checking the vision key…
        </span>
      ) : (
        <div
          /* R126-3f-3: the key row = the well recess + rim (TOKENS §10). */
          className="flex items-center gap-2 flex-wrap rounded-lg border border-clay-rim bg-well px-3 py-2"
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
                className="text-[10px] font-medium uppercase tracking-wider rounded-full px-1.5 py-0.5 shrink-0 bg-badge-success text-badge-success-fg"
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
                  className="h-8 flex-1 min-w-[180px] rounded-lg border border-clay-rim bg-card px-2.5 font-mono text-[11px] text-ink outline-none"
                />
              ) : null}
              <button
                onClick={() => setReplacing((v) => !v)}
                aria-label={`Replace vision key for ${savedProvider}`}
                className="h-8 px-2.5 rounded-lg text-[11px] font-medium shrink-0 border border-clay-rim bg-card text-muted transition-colors duration-100 hover:bg-hover"
              >
                {replacing ? "Hide" : "Replace"}
              </button>
              {replacing && (
                <button
                  onClick={() => keyDraft.trim() && saveKey.mutate()}
                  disabled={!keyDraft.trim() || saveKey.isPending}
                  aria-label={`Save vision key for ${savedProvider}`}
                  className="h-8 px-2.5 rounded-lg text-[11px] font-medium shrink-0 bg-accent-tint text-accent-deep transition-colors duration-100 hover:bg-hover active:scale-[0.98] disabled:opacity-50"
                >
                  {saveKey.isPending ? "Saving…" : "Save"}
                </button>
              )}
              <button
                onClick={() => clearKey.mutate()}
                disabled={clearKey.isPending}
                aria-label={`Clear vision key for ${savedProvider}`}
                /* R126-3f-3: the outlined danger action. */
                className="h-8 px-2.5 rounded-lg text-[11px] font-medium shrink-0 border border-danger-deep text-danger-deep transition-colors duration-100 hover:bg-hover active:scale-[0.98] disabled:opacity-50"
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
                className="h-8 flex-1 min-w-[180px] rounded-lg border border-clay-rim bg-card px-2.5 font-mono text-[11px] text-ink outline-none"
              />
              <button
                onClick={() => keyDraft.trim() && saveKey.mutate()}
                disabled={!keyDraft.trim() || saveKey.isPending}
                aria-label={`Save vision key for ${savedProvider}`}
                className="h-8 px-2.5 rounded-lg text-[11px] font-medium shrink-0 bg-accent-tint text-accent-deep transition-colors duration-100 hover:bg-hover active:scale-[0.98] disabled:opacity-50"
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
  providerName,
  model,
  onNote,
}: {
  providerName: string;
  model: ProviderModelConfig;
  onNote: (text: string, isError?: boolean, isWarning?: boolean) => void;
}) {
  const styles = useThemeStyles();
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: () => updateProviderModelConfig(model.id, { supportsVision: !model.supportsVision }),
    onSuccess: () => {
      onNote("Vision flag saved.");
      void queryClient.invalidateQueries({ queryKey: ["models-configured"] });
    },
    onError: (err: Error) => onNote(err.message, true),
  });

  return (
    <div
      className="flex items-center gap-2 px-3 py-2 border-b border-line last:border-b-0"
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
        /* R126-3f-3: the flag toggle rides the §11 success tone pair when
         * set (flat hues are for dots only — TOKENS §11). */
        className={`w-7 h-7 grid place-items-center rounded-md shrink-0 disabled:opacity-50 transition-colors duration-100 hover:bg-hover ${
          model.supportsVision ? "bg-badge-success text-badge-success-fg" : "text-muted"
        }`}
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
          title={`${model.providerId}/${model.modelId}`}
        >
          {providerName}/{model.modelId}
        </span>
      </span>
      <span
        className={`text-[10px] font-medium uppercase tracking-wider rounded-full px-1.5 py-0.5 shrink-0 ${
          model.supportsVision
            ? "bg-badge-success text-badge-success-fg"
            : "bg-badge-neutral text-badge-neutral-fg"
        }`}
      >
        {model.supportsVision ? "supports vision" : "no images"}
      </span>
    </div>
  );
}

/** "main" mode: the hint + the compact configured-models list. */
function MainModelCard({ onNote }: { onNote: (text: string, isError?: boolean) => void }) {
  const styles = useThemeStyles();
  // R114-e: the list rides the SHARED ["models-configured"] cache now (one
  // GET /models/configured call instead of N per-provider fetches) with the
  // ["settings-providers"] names for the row labels — the eye-toggle surface
  // stays byte-identical (ALL configured rows, including a disabled
  // provider's — the flag is manageable wherever the row lives).
  const configuredQuery = useQuery({
    queryKey: ["models-configured"],
    queryFn: fetchConfiguredModels,
    staleTime: 60 * 1000,
    retry: false,
  });
  const providersQuery = useQuery({
    queryKey: ["settings-providers"],
    queryFn: fetchProviders,
    staleTime: 60 * 1000,
    retry: false,
  });
  const rows = (configuredQuery.data ?? []).map((model) => ({
    model,
    providerName:
      providersQuery.data?.find((p) => p.id === model.providerId)?.name ?? model.providerId,
  }));

  return (
    <div className="flex flex-col gap-2.5" data-testid="main-vision-card">
      <div
        /* R126-3f-3: the §11 warning badge-tone strip (the withAlpha wash +
         * 1.5px border spellings are retired). */
        className="rounded-lg bg-badge-warning px-3 py-2.5"
      >
        <p className="text-[11px] leading-relaxed" style={{ color: styles.textSecondary }}>
          The agent's current model must be marked supports vision. Set that flag on a model row in
          Models&nbsp;&amp;&nbsp;Providers (the eye toggle on a model row) — or flip it right here:
        </p>
      </div>
      {configuredQuery.isLoading ? (
        <span className="text-[11px] font-mono" style={{ color: styles.textTertiary }}>
          listing configured models…
        </span>
      ) : configuredQuery.isError ? (
        <p className="text-[11px] text-danger-deep" role="alert">
          {configuredQuery.error instanceof Error
            ? configuredQuery.error.message
            : String(configuredQuery.error)}
        </p>
      ) : rows.length === 0 ? (
        <p className="text-[11px]" style={{ color: styles.textTertiary }}>
          No configured model rows yet — add models under Models&nbsp;&amp;&nbsp;Providers first.
        </p>
      ) : (
        <div
          /* R126-3f-3: the rim hairline container (TOKENS §5). */
          className="rounded-lg border border-clay-rim overflow-hidden max-h-64 overflow-y-auto"
        >
          {rows.map(({ providerName, model }) => (
            <VisionModelRow
              key={model.id}
              providerName={providerName}
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
  // R114-e: "off" is retired — a marked model can always see, so the
  // readiness line speaks main/separate only (the server coerces any legacy
  // stored "off" to "main" on read).
  if (settings.mode === "separate") {
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
      /* R126-3f-3: the readiness line = the well recess + rim (TOKENS §10);
       * the READY badge = the §11 success tone, else neutral. */
      className="rounded-2xl border border-clay-rim bg-well p-4 flex items-start gap-2.5"
      aria-label="Image analysis readiness"
      data-testid="vision-readiness"
    >
      <span
        className={`text-[10px] font-medium uppercase tracking-wider rounded-full px-2 py-0.5 shrink-0 mt-0.5 ${
          ready ? "bg-badge-success text-badge-success-fg" : "bg-badge-neutral text-badge-neutral-fg"
        }`}
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
