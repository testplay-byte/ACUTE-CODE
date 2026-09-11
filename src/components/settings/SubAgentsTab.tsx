import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { Activity, Check, Cpu, KeyRound, Workflow } from "lucide-react";
import { useTimeoutClear } from "../../hooks/use-timeout-clear";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { withAlpha } from "../dashboard/helpers";
import { isTauri } from "../../lib/sidecar";
import { filterModelsForPicker, useSettingsStore } from "../../lib/settings-store";
import {
  fetchConfiguredModels,
  fetchModelsCatalog,
  fetchOrchestrationSettings,
  updateOrchestrationSettings,
  type OrchestrationSettings,
  type ProviderModelConfig,
  type SubagentModelRef,
} from "../../lib/api";

/**
 * SubAgentsTab — ROUND-43 (R43-5, owner directive): the dedicated home for
 * sub-agent configuration.
 *
 * ROUND-58 (R58-d) RESTRUCTURE (owner: "the subagent and advanced options
 * are apparently mixed up… recreate these two pages properly"): this tab is
 * the SINGLE home for everything sub-agent — model, parallelism, and
 * supervision.
 *
 * ROUND-92 (R92-D3, owner directive): sub-agents DO NOT have their own API
 * keys anymore — they use each provider's key pool (the multi-key juggling
 * the orchestrator now does: a rejected/rate-limited key fails over to the
 * next one automatically). The old hardcoded "Sub-agent OpenRouter keys"
 * paste-slot card (openrouter slots 2/3/4) is DELETED; in its place sits a
 * compact note pointing at the one true key manager, Models & Providers →
 * API keys. The sub-agent MODEL selection stays exactly as it was
 * (inherit row + served catalog picker + configured rows, R82), as do the
 * parallelism and supervision cards.
 */

/**
 * ROUND-53: the old copy told the PACKAGED app's owner to run `pnpm dev:full`
 * — dev-workflow advice shown in a desktop install. Mode-aware now: the
 * desktop app points at the connection banner's Restart engine action.
 */
const coreUnreachableHint = isTauri()
  ? "agent-core is not responding — if the connection banner is showing, use its Restart engine button, then reopen this tab."
  : "Agent core unreachable — start the app (or pnpm dev:full).";

function formatCtx(ctx: number): string {
  return ctx >= 1_000_000 ? `${Math.round(ctx / 1_048_576)}M` : `${Math.round(ctx / 1000)}K`;
}

// ROUND-47 (R47-c2): OrchestrationSettings gained `subagentModel` in api.ts
// (R47-c1) — the local widening that used to bridge the gap is deleted; the
// picker talks to the typed API surface directly.
async function fetchSubagentSettings(): Promise<OrchestrationSettings> {
  return fetchOrchestrationSettings();
}

async function saveSubagentSettings(patch: {
  maxParallel?: number;
  perKeyLimit?: number;
  /** ROUND-82 (R82): the provider-scoped ref (a bare catalog id no longer
   * reaches here — the picker builds the {providerId, modelId} pair). */
  subagentModel?: SubagentModelRef | null;
  childWatchdogMs?: number;
  childStallTimeoutMs?: number;
}): Promise<OrchestrationSettings> {
  return updateOrchestrationSettings(patch);
}

/* ── Card 1 (R92-D3): sub-agents use the provider key pools ─────────────── */

/**
 * The compact informational note that replaced the old hardcoded
 * "Sub-agent OpenRouter keys" paste-slot card. The owner's rework: sub-agents
 * do NOT have separate keys — they ride each provider's key pool (juggled
 * automatically on rate limits / auth failures). Keys are added and managed
 * in exactly ONE place: Models & Providers → the provider → API keys.
 */
function SubAgentKeysNote() {
  const styles = useThemeStyles();
  return (
    <section
      className="rounded-[16px] border-[1.5px] p-4 flex items-center gap-3 flex-wrap"
      style={{ background: styles.card, borderColor: styles.border }}
      aria-label="Sub-agent API keys"
      data-testid="subagent-keys-note"
    >
      <span
        className="w-9 h-9 shrink-0 rounded-[10px] grid place-items-center"
        style={{ background: withAlpha(styles.accent, 0.1), color: styles.accent }}
        aria-hidden
      >
        <KeyRound size={15} />
      </span>
      <p className="min-w-0 flex-1 text-[12px]" style={{ color: styles.textSecondary }}>
        Sub-agents use the API key pool of each provider — add and manage keys under
        Models &amp; Providers.
      </p>
      <Link
        to="/settings?tab=api"
        aria-label="Open Models and Providers to manage API keys"
        className="h-8 px-3 rounded-[8px] text-[11px] font-bold flex items-center gap-1.5 shrink-0"
        style={{ background: withAlpha(styles.accent, 0.12), color: styles.accent }}
      >
        <KeyRound size={11} /> Manage keys
      </Link>
    </section>
  );
}

/* ── Card 2: sub-agent model picker ───────────────────────────────────────── */

function SubAgentModelCard() {
  const styles = useThemeStyles();
  const queryClient = useQueryClient();
  const resetAfter = useTimeoutClear();
  const [msg, setMsg] = useState<string | null>(null);

  const settingsQuery = useQuery({
    queryKey: ["orchestration-settings"],
    queryFn: fetchSubagentSettings,
  });

  // ROUND-47 (R47-c2): the model catalog is FETCHED, not hand-copied — GET
  // /models/catalog serves agent-core's MODEL_CATALOG (single source of
  // truth). The 47-entry local duplicate that used to live here was exactly
  // the drift class the tool drift guard exists for (AGENT-MEMORY #65).
  // Constants on the wire → generous staleTime; no auto-retry — an honest
  // error card with a retry button beats a silent retry loop.
  const catalogQuery = useQuery({
    queryKey: ["models-catalog"],
    queryFn: fetchModelsCatalog,
    staleTime: 10 * 60 * 1000,
    retry: false,
  });

  const modelsFreeOnly = useSettingsStore((s) => s.modelsFreeOnly);
  const setModelsFreeOnly = useSettingsStore((s) => s.setModelsFreeOnly);

  const saveModel = useMutation({
    mutationFn: (ref: SubagentModelRef | null) => saveSubagentSettings({ subagentModel: ref }),
    onSuccess: (_data, ref) => {
      setMsg(ref === null ? "Cleared — inherits main model." : "Saved.");
      resetAfter(() => setMsg(null), 1500);
      void queryClient.invalidateQueries({ queryKey: ["orchestration-settings"] });
    },
    onError: (err: Error) => setMsg(err.message),
  });

  // ROUND-82 (R82, §2.4.5 — the NVIDIA sub-agent gap): the CONFIGURED model
  // rows across all providers (GET /models/configured). Non-fatal: an error
  // hides this section only (the catalog section below keeps working — the
  // endpoint is additive). StaleTime 60s: rows change only through the
  // Models & Providers page, whose mutations invalidate the family.
  // NOTE (R82 close-out): declared BEFORE the early returns below — ALL
  // hooks must run on every render (the Rules of Hooks; the interrupted
  // R82 session had it after the returns, which crashed the card with a
  // hook-order error as soon as a query state changed between renders).
  const configuredQuery = useQuery({
    queryKey: ["models-configured"],
    queryFn: fetchConfiguredModels,
    staleTime: 60 * 1000,
    retry: false,
  });

  const settingsPending = settingsQuery.isLoading || settingsQuery.data === undefined;
  if (settingsQuery.isError) {
    return (
      <section
        className="rounded-[16px] border-[1.5px] p-4"
        style={{ background: styles.card, borderColor: styles.border }}
        aria-label="Sub-agent model"
      >
        <p className="text-[11px]" style={{ color: "#ef4444" }} role="alert">
          {coreUnreachableHint} to pick a sub-agent model.
        </p>
      </section>
    );
  }
  // ROUND-47 (R47-c2): honest catalog failure — NO hidden fallback copy of
  // the catalog. The backend's own message + a retry affordance; the picker
  // simply doesn't render until the truth is available.
  if (catalogQuery.isError) {
    return (
      <section
        className="rounded-[16px] border-[1.5px] p-4 flex flex-col gap-2.5"
        style={{ background: styles.card, borderColor: styles.border }}
        aria-label="Sub-agent model"
      >
        <div className="flex items-center gap-2">
          <Cpu size={13} style={{ color: styles.accent, opacity: 0.8 }} />
          <span className="text-[13px] font-bold" style={{ color: styles.text }}>
            Sub-agent model
          </span>
        </div>
        <p className="text-[11px]" style={{ color: "#ef4444" }} role="alert">
          Model catalog unavailable — {catalogQuery.error instanceof Error ? catalogQuery.error.message : String(catalogQuery.error)}
        </p>
        <div>
          <button
            onClick={() => void catalogQuery.refetch()}
            aria-label="Retry loading the model catalog"
            className="h-8 px-3 rounded-[8px] text-[11px] font-bold"
            style={{ background: withAlpha(styles.accent, 0.12), color: styles.accent }}
          >
            Retry
          </button>
        </div>
      </section>
    );
  }

  const settings = settingsQuery.data;
  const catalog = catalogQuery.data;
  if (settingsPending || settings === undefined || catalog === undefined) {
    return (
      <section
        className="rounded-[16px] border-[1.5px] p-4"
        style={{ background: styles.card, borderColor: styles.border }}
        aria-label="Sub-agent model"
      >
        <span className="text-[12px] font-mono" style={{ color: styles.textTertiary }}>
          {settingsPending || settings === undefined ? "loading sub-agent model settings…" : "loading the model catalog…"}
        </span>
      </section>
    );
  }

  const selected = settings.subagentModel;
  const selectedEntry = catalog.models.find((m) => m.modelId === selected?.modelId);
  // ROUND-82: the configured-section rows — every provider's rows EXCEPT
  // openrouter ids the catalog above already lists (they would duplicate;
  // picking either lands on the same {providerId, modelId} key).
  const catalogIds = new Set(catalog.models.map((m) => m.modelId));
  const configuredRows: ProviderModelConfig[] = (configuredQuery.data ?? []).filter(
    (m) => !(m.providerId === "openrouter" && catalogIds.has(m.modelId)),
  );

  // CatalogModel → the picker row shape the shared free-only filter expects.
  // The `free` flag drives the filter (identical to the old local catalog's
  // free column: free ⇒ $0 input price, paid ⇒ null = never "free").
  const toPickerRows = () =>
    catalog.models.map((m) => ({
      modelId: m.modelId,
      displayName: m.displayName,
      contextWindow: m.contextWindow,
      free: m.free,
      supportsTools: m.supportsTools,
      inputPricePerMtok: m.free ? 0 : null,
    }));

  const rows = filterModelsForPicker(toPickerRows(), modelsFreeOnly);
  const freeCount = filterModelsForPicker(toPickerRows(), true).length;
  // Data-driven "recommended" pin (ROUND-47 R47-c2): this is the SUB-AGENT
  // surface, so the badge stays on the sub-agent default — the recommended
  // id (it rides in recommendedModelIds) the orchestrator actually launches
  // children on. Identical visible UX to the old hardcoded nemotron const.
  const recommendedId = catalog.subagentDefaultModelId;

  return (
    <section
      className="rounded-[16px] border-[1.5px] p-4 flex flex-col gap-2.5"
      style={{ background: styles.card, borderColor: styles.border }}
      aria-label="Sub-agent model"
    >
      <div className="flex items-center gap-2 flex-wrap">
        <Cpu size={13} style={{ color: styles.accent, opacity: 0.8 }} />
        <span className="text-[13px] font-bold" style={{ color: styles.text }}>
          Sub-agent model
        </span>
        <span className="flex-1" />
        {msg && (
          <span
            className="text-[11px] font-bold"
            style={{ color: saveModel.isError ? "#ef4444" : "#22c55e" }}
          >
            {msg}
          </span>
        )}
      </div>

      {/* Current override state */}
      <div
        className="flex items-center gap-2 rounded-[10px] border-[1.5px] px-3 py-2"
        style={{ borderColor: selected ? withAlpha(styles.accent, 0.45) : styles.border, background: withAlpha(styles.accent, 0.04) }}
      >
        <span className="text-[11px] font-bold shrink-0" style={{ color: styles.textTertiary }}>
          RUNNING ON
        </span>
        {selected === null ? (
          <span className="text-[12px] font-bold" style={{ color: styles.textSecondary }}>
            Inherits main model
          </span>
        ) : (
          <span className="text-[12px] font-bold min-w-0 truncate" style={{ color: styles.text }}>
            {selectedEntry?.displayName ?? selected.modelId}
            <span className="font-mono text-[11px] ml-1.5" style={{ color: styles.textTertiary }}>
              {/* ROUND-82: the provider chip — the child turns route to THIS
                  provider (the R82 override wire); the old bare id left the
                  routing target invisible. */}
              {selected.providerId} · {selected.modelId}
            </span>
          </span>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div
          role="group"
          aria-label="Sub-agent model filter"
          className="flex items-center rounded-[10px] border-[1.5px] overflow-hidden"
          style={{ borderColor: styles.border }}
        >
          {([
            { id: "free", label: `Free only (${freeCount})`, active: modelsFreeOnly, pick: () => setModelsFreeOnly(true) },
            { id: "all", label: `All models (${catalog.models.length})`, active: !modelsFreeOnly, pick: () => setModelsFreeOnly(false) },
          ] as const).map((seg) => (
            <button
              key={seg.id}
              onClick={seg.pick}
              aria-pressed={seg.active}
              className="h-7 px-2.5 text-[11px] font-bold transition-colors"
              style={{
                background: seg.active ? withAlpha(styles.accent, 0.12) : "transparent",
                color: seg.active ? styles.accent : styles.textTertiary,
              }}
            >
              {seg.label}
            </button>
          ))}
        </div>
        <span className="text-[10.5px] flex-1 min-w-[180px]" style={{ color: styles.textTertiary }}>
          Free by default (shared with the model pickers). Only tool-capable models can be picked.
        </span>
      </div>

      <div className="rounded-[10px] border-[1.5px] overflow-hidden" style={{ borderColor: styles.border }}>
        {/* Inherit row */}
        <button
          onClick={() => saveModel.mutate(null)}
          aria-label="Inherit the main model for sub-agents"
          className="w-full flex items-center gap-2 px-3 py-2 border-b text-left"
          style={{
            borderColor: styles.borderSubtle,
            background: selected === null ? withAlpha(styles.accent, 0.07) : "transparent",
          }}
        >
          <span className="text-[12px] font-bold" style={{ color: styles.text }}>
            Inherits main model <span style={{ color: styles.textTertiary, fontWeight: 400 }}>(default)</span>
          </span>
          <span className="flex-1" />
          {selected === null && <Check size={12} style={{ color: styles.accent }} />}
        </button>

        <div className="max-h-64 overflow-y-auto">
          {rows.map((m) => {
            const disabled = !m.supportsTools;
            // ROUND-82: openrouter-scoped selection key (the catalog is
            // OpenRouter's — picking a row writes the explicit pair).
            const isSelected =
              selected !== null && selected.providerId === "openrouter" && selected.modelId === m.modelId;
            const recommended = m.modelId === recommendedId;
            return (
              <button
                key={m.modelId}
                onClick={() =>
                  !disabled && saveModel.mutate({ providerId: "openrouter", modelId: m.modelId })
                }
                disabled={disabled}
                aria-label={disabled ? `${m.modelId} (unavailable)` : `Use ${m.modelId} for sub-agents`}
                title={disabled ? "tool calling required" : m.modelId}
                className="w-full flex items-center gap-2 px-3 py-2 border-b last:border-b-0 text-left disabled:cursor-not-allowed"
                style={{
                  borderColor: styles.borderSubtle,
                  background: isSelected ? withAlpha(styles.accent, 0.07) : "transparent",
                  opacity: disabled ? 0.55 : 1,
                }}
              >
                <span className="min-w-0 flex-1 flex items-center gap-1.5 flex-wrap">
                  <span
                    className="text-[12px] font-bold truncate"
                    style={{ color: disabled ? styles.textTertiary : styles.text }}
                  >
                    {m.displayName}
                  </span>
                  {recommended && (
                    <span
                      className="text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5"
                      style={{ background: withAlpha(styles.accent, 0.14), color: styles.accent }}
                    >
                      recommended
                    </span>
                  )}
                  {m.free && !recommended && (
                    <span
                      className="text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5"
                      style={{ background: withAlpha("#22c55e", 0.14), color: "#22c55e" }}
                    >
                      free
                    </span>
                  )}
                </span>
                <span className="font-mono text-[10px] shrink-0" style={{ color: styles.textTertiary }}>
                  {m.modelId}
                </span>
                <span className="text-[10px] shrink-0 tabular-nums" style={{ color: styles.textTertiary }}>
                  {formatCtx(m.contextWindow)}
                </span>
                {disabled ? (
                  <span className="text-[9.5px] font-bold shrink-0" style={{ color: "#D64545" }}>
                    tool calling required
                  </span>
                ) : isSelected ? (
                  <Check size={12} style={{ color: styles.accent }} />
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      {/* ROUND-82 (R82, §2.4.5 — the NVIDIA sub-agent gap): YOUR CONFIGURED
          MODELS, per provider. The section above lists the OpenRouter
          catalog only — a NIM (nvidia) or custom-gateway row could never be
          the sub-agent model. Each row here writes the provider-scoped
          {providerId, modelId} pair, and the R82 orchestrator override
          routes the child turns to THAT provider. Hidden entirely when the
          query fails or no non-catalog rows exist (nothing to show — the
          catalog above is the complete picker in that case). */}
      {configuredRows.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-[11px] font-bold" style={{ color: styles.textSecondary }}>
            Your configured models
          </span>
          <div
            className="rounded-[10px] border-[1.5px] overflow-hidden"
            style={{ borderColor: styles.border }}
            data-testid="subagent-configured-models"
          >
            <div className="max-h-40 overflow-y-auto">
              {configuredRows.map((m) => {
                const isSelected =
                  selected !== null && selected.providerId === m.providerId && selected.modelId === m.modelId;
                // Tri-state tools: explicit false disables (the honest gate);
                // null (unknown) stays pickable — the row's own Test button
                // (Models & Providers) is the ground truth.
                const disabled = m.supportsTools === false;
                return (
                  <button
                    key={`${m.providerId}:${m.modelId}`}
                    onClick={() =>
                      !disabled && saveModel.mutate({ providerId: m.providerId, modelId: m.modelId })
                    }
                    disabled={disabled}
                    aria-label={`Use ${m.modelId} on ${m.providerId} for sub-agents`}
                    title={disabled ? "marked as not tool-capable" : `${m.providerId} · ${m.modelId}`}
                    className="w-full flex items-center gap-2 px-3 py-2 border-b last:border-b-0 text-left disabled:cursor-not-allowed"
                    style={{
                      borderColor: styles.borderSubtle,
                      background: isSelected ? withAlpha(styles.accent, 0.07) : "transparent",
                      opacity: disabled ? 0.55 : 1,
                    }}
                  >
                    <span className="min-w-0 flex-1 flex items-center gap-1.5 flex-wrap">
                      <span
                        className="text-[12px] font-bold truncate"
                        style={{ color: disabled ? styles.textTertiary : styles.text }}
                      >
                        {m.displayName || m.modelId}
                      </span>
                      <span
                        className="shrink-0 px-1.5 py-0.5 rounded-full font-mono text-[9.5px] font-bold"
                        style={{ background: styles.subtle, color: styles.textTertiary }}
                        title="The provider the child turns route to"
                      >
                        {m.providerId}
                      </span>
                    </span>
                    <span className="font-mono text-[10px] shrink-0 truncate max-w-[45%]" style={{ color: styles.textTertiary }}>
                      {m.modelId}
                    </span>
                    {disabled ? (
                      <span className="text-[9.5px] font-bold shrink-0" style={{ color: "#D64545" }}>
                        no tool calling
                      </span>
                    ) : isSelected ? (
                      <Check size={12} style={{ color: styles.accent }} />
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
          <span className="text-[10.5px]" style={{ color: styles.textTertiary }}>
            Rows added in Models &amp; Providers (NVIDIA NIM, custom gateways) — sub-agent turns route to the
            row&apos;s provider.
          </span>
        </div>
      )}
      <p className="text-[10.5px]" style={{ color: styles.textTertiary }}>
        Applies to every delegated sub-agent turn (delegate_task + retries). Parallelism and
        supervision live in the cards below — same page now.
      </p>
    </section>
  );
}

/* ── Card 3 (ROUND-58 R58-d): sub-agent PARALLELISM — moved from Advanced ─── */

/** The two orchestration limits, moved here from the old Advanced tab's
 * OrchestrationCard (R58-d: they are sub-agent limits, not advanced ones).
 * Same wire contract — PUT /settings/orchestration {maxParallel?,
 * perKeyLimit?} — and the same stepper UX, now beside the keys/model it
 * actually governs. */
function SubAgentParallelismCard() {
  const styles = useThemeStyles();
  const queryClient = useQueryClient();
  const resetAfter = useTimeoutClear();
  const [draft, setDraft] = useState<{ maxParallel?: number; perKeyLimit?: number }>({});
  const [msg, setMsg] = useState<string | null>(null);

  const settingsQuery = useQuery({
    queryKey: ["orchestration-settings"],
    queryFn: fetchSubagentSettings,
  });

  const update = useMutation({
    mutationFn: (patch: { maxParallel?: number; perKeyLimit?: number }) =>
      saveSubagentSettings(patch),
    onSuccess: () => {
      setMsg("Saved.");
      resetAfter(() => setMsg(null), 1500);
      setDraft({});
      void queryClient.invalidateQueries({ queryKey: ["orchestration-settings"] });
    },
    onError: (err: Error) => setMsg(err.message),
  });

  if (settingsQuery.isError) {
    return (
      <section
        className="rounded-[16px] border-[1.5px] p-4"
        style={{ background: styles.card, borderColor: styles.border }}
        aria-label="Sub-agent parallelism"
      >
        <p className="text-[11px]" style={{ color: "#ef4444" }} role="alert">
          {coreUnreachableHint} to tune sub-agent parallelism.
        </p>
      </section>
    );
  }
  const current = settingsQuery.data;
  if (settingsQuery.isLoading || current === undefined) {
    return (
      <section
        className="rounded-[16px] border-[1.5px] p-4"
        style={{ background: styles.card, borderColor: styles.border }}
        aria-label="Sub-agent parallelism"
      >
        <span className="text-[12px] font-mono" style={{ color: styles.textTertiary }}>
          loading parallelism settings…
        </span>
      </section>
    );
  }

  const stepper = (label: string, hint: string, field: "maxParallel" | "perKeyLimit", min: number, max: number, inputLabel: string, testId: string) => (
    <div className="flex items-center gap-3 flex-wrap" data-testid={testId}>
      <div className="min-w-[220px] flex-1">
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
            className="w-8 h-8 rounded-[10px] grid place-items-center border-[1.5px] text-[14px] font-black shrink-0"
            style={{ borderColor: styles.border, color: styles.textSecondary, background: styles.bg }}
          >
            {delta > 0 ? "+" : "−"}
          </button>
        ))}
        <span
          className="w-14 text-center text-[15px] font-black tabular-nums rounded-[10px] py-1"
          style={{ background: withAlpha(styles.accent, 0.09), color: styles.accent }}
          aria-label={inputLabel}
        >
          {draft[field] ?? current[field]}
        </span>
      </div>
    </div>
  );

  const dirty = draft.maxParallel !== undefined || draft.perKeyLimit !== undefined;

  return (
    <section
      className="rounded-[16px] border-[1.5px] p-4 flex flex-col gap-4"
      style={{ background: styles.card, borderColor: styles.border }}
      aria-label="Sub-agent parallelism"
    >
      <div className="flex items-center gap-2 flex-wrap">
        <Workflow size={13} style={{ color: styles.accent, opacity: 0.8 }} />
        <span className="text-[13px] font-bold" style={{ color: styles.text }}>
          Sub-agent parallelism
        </span>
        <span className="flex-1" />
        {msg && (
          <span
            className="text-[11px] font-bold"
            style={{ color: update.isError ? "#ef4444" : "#22c55e" }}
          >
            {msg}
          </span>
        )}
      </div>
      <p className="text-[11px] leading-relaxed" style={{ color: styles.textSecondary }}>
        How hard the orchestrator may run delegated children at once — across the whole turn and
        per API key (the per-key cap spreads the load over the provider&apos;s key pool).
      </p>
      <div className="flex flex-col gap-2">
        {stepper(
          "Max parallel sub-agents",
          "Total concurrent sub-agent sessions (1–50)",
          "maxParallel",
          1,
          50,
          "Max parallel sub-agents value",
          "max-parallel-field",
        )}
        {stepper(
          "Per API-key limit",
          "Concurrent sub-agents per key — spreads load over the key pool (1–20)",
          "perKeyLimit",
          1,
          20,
          "Per API-key limit value",
          "per-key-limit-field",
        )}
      </div>
      <div className="flex items-center gap-3">
        <p className="text-[10.5px] flex-1" style={{ color: styles.textTertiary }}>
          Each key carries at most this many children at once; extra pool keys raise the ceiling.
        </p>
        <button
          onClick={() => update.mutate(draft)}
          disabled={!dirty || update.isPending}
          aria-label="Save sub-agent parallelism settings"
          className="h-8 px-3 rounded-[8px] text-[11px] font-bold shrink-0 disabled:opacity-50"
          style={{ background: withAlpha(styles.accent, 0.12), color: styles.accent }}
        >
          {update.isPending ? "Saving…" : "Save"}
        </button>
      </div>
    </section>
  );
}

/* ── Card 3 (ROUND-52 R52-b): the supervisor knobs ────────────────────────── */

/** childWatchdogMs's valid range in SECONDS (server validates 5000–60000ms). */
const WATCHDOG_SECONDS_MIN = 5;
const WATCHDOG_SECONDS_MAX = 60;
/** childStallTimeoutMs's valid range in MINUTES (server validates
 * 60000–3600000ms; the field is shown in minutes — every allowed value is
 * ≥ 1 minute). */
const STALL_MINUTES_MIN = 1;
const STALL_MINUTES_MAX = 60;

/** The sidecar's defaults (orchestration settings) — display fallbacks. */
const WATCHDOG_DEFAULT_MS = 15_000;
const STALL_DEFAULT_MS = 300_000;

/**
 * ROUND-52 (R52-b): the two supervisor knobs of the orchestration family:
 * how often running sub-agents report what they're doing (the heartbeat
 * that feeds the Sub-agent panel's watch line) and how long a child may
 * stay silent before the supervisor stops it and reports honestly to the
 * parent turn. Inputs are in DISPLAY units (seconds / minutes) — the
 * ms↔s/min conversion happens ONLY here at the boundary.
 */
function SubAgentSupervisionCard() {
  const styles = useThemeStyles();
  const queryClient = useQueryClient();
  const resetAfter = useTimeoutClear();
  const [msg, setMsg] = useState<string | null>(null);
  const [msgIsError, setMsgIsError] = useState(false);
  // Drafts in DISPLAY units; "" = untouched (the current value shows).
  const [heartbeatDraft, setHeartbeatDraft] = useState("");
  const [stallDraft, setStallDraft] = useState("");

  const settingsQuery = useQuery({
    queryKey: ["orchestration-settings"],
    queryFn: fetchSubagentSettings,
  });

  const save = useMutation({
    mutationFn: (patch: { childWatchdogMs?: number; childStallTimeoutMs?: number }) =>
      saveSubagentSettings(patch),
    onSuccess: () => {
      setMsg("Saved.");
      setMsgIsError(false);
      setHeartbeatDraft("");
      setStallDraft("");
      resetAfter(() => setMsg(null), 1500);
      void queryClient.invalidateQueries({ queryKey: ["orchestration-settings"] });
    },
    onError: (err: Error) => {
      setMsg(err.message);
      setMsgIsError(true);
    },
  });

  if (settingsQuery.isError) {
    return (
      <section
        className="rounded-[16px] border-[1.5px] p-4"
        style={{ background: styles.card, borderColor: styles.border }}
        aria-label="Sub-agent supervision"
      >
        <p className="text-[11px]" style={{ color: "#ef4444" }} role="alert">
          {coreUnreachableHint} to tune sub-agent supervision.
        </p>
      </section>
    );
  }
  const current = settingsQuery.data;
  if (settingsQuery.isLoading || current === undefined) {
    return (
      <section
        className="rounded-[16px] border-[1.5px] p-4"
        style={{ background: styles.card, borderColor: styles.border }}
        aria-label="Sub-agent supervision"
      >
        <span className="text-[12px] font-mono" style={{ color: styles.textTertiary }}>
          loading supervision settings…
        </span>
      </section>
    );
  }

  // ms → display units at the boundary (rounded; every valid server value
  // divides cleanly).
  const heartbeatSeconds = Math.round((current.childWatchdogMs ?? WATCHDOG_DEFAULT_MS) / 1000);
  const stallMinutes = Math.round((current.childStallTimeoutMs ?? STALL_DEFAULT_MS) / 60_000);
  const heartbeatValue = heartbeatDraft === "" ? String(heartbeatSeconds) : heartbeatDraft;
  const stallValue = stallDraft === "" ? String(stallMinutes) : stallDraft;

  const heartbeatNum = Number(heartbeatValue);
  const heartbeatValid =
    Number.isInteger(heartbeatNum) &&
    heartbeatNum >= WATCHDOG_SECONDS_MIN &&
    heartbeatNum <= WATCHDOG_SECONDS_MAX;
  const stallNum = Number(stallValue);
  const stallValid =
    Number.isInteger(stallNum) && stallNum >= STALL_MINUTES_MIN && stallNum <= STALL_MINUTES_MAX;

  const heartbeatDirty = heartbeatDraft !== "" && heartbeatValue !== String(heartbeatSeconds);
  const stallDirty = stallDraft !== "" && stallValue !== String(stallMinutes);
  const dirty = heartbeatDirty || stallDirty;

  const onSave = () => {
    const patch: { childWatchdogMs?: number; childStallTimeoutMs?: number } = {};
    if (heartbeatDirty && heartbeatValid) patch.childWatchdogMs = heartbeatNum * 1000;
    if (stallDirty && stallValid) patch.childStallTimeoutMs = stallNum * 60_000;
    if (Object.keys(patch).length > 0) save.mutate(patch);
  };

  const field = (
    label: string,
    hint: string,
    value: string,
    valid: boolean,
    rangeError: string,
    suffix: string,
    onChange: (v: string) => void,
    inputLabel: string,
    min: number,
    max: number,
    testId: string,
  ) => (
    <div className="flex items-center gap-3 flex-wrap" data-testid={testId}>
      <div className="min-w-[220px] flex-1">
        <div className="text-[12.5px] font-bold" style={{ color: styles.text }}>
          {label}
        </div>
        <div className="text-[11px]" style={{ color: styles.textTertiary }}>
          {hint}
        </div>
        {!valid ? (
          <div
            className="text-[10.5px] font-bold"
            style={{ color: "#ef4444" }}
            role="alert"
            data-testid={`${testId}-error`}
          >
            {rangeError}
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-1.5">
        <input
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={inputLabel}
          className="w-20 h-8 rounded-[8px] border-[1.5px] px-2.5 font-mono text-[11px] outline-none text-right"
          style={{
            background: styles.bg,
            borderColor: !valid ? "#ef4444" : styles.border,
            color: styles.text,
          }}
        />
        <span className="text-[11px] font-mono shrink-0" style={{ color: styles.textTertiary }}>
          {suffix}
        </span>
      </div>
    </div>
  );

  return (
    <section
      className="rounded-[16px] border-[1.5px] p-4 flex flex-col gap-2.5"
      style={{ background: styles.card, borderColor: styles.border }}
      aria-label="Sub-agent supervision"
    >
      <div className="flex items-center gap-2 flex-wrap">
        <Activity size={13} style={{ color: styles.accent, opacity: 0.8 }} />
        <span className="text-[13px] font-bold" style={{ color: styles.text }}>
          Sub-agent supervision
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
        The supervisor watches every running sub-agent: each one reports what it is doing on every
        heartbeat (the Sub-agent panel's live watch line), and one that stays silent past the stall
        timeout is stopped and reported honestly to the parent turn.
      </p>
      <div className="flex flex-col gap-2">
        {field(
          "Supervisor heartbeat",
          "How often running sub-agents report what they're doing",
          heartbeatValue,
          heartbeatValid,
          `Heartbeat must be ${WATCHDOG_SECONDS_MIN}–${WATCHDOG_SECONDS_MAX} seconds`,
          "s",
          setHeartbeatDraft,
          "Supervisor heartbeat seconds",
          WATCHDOG_SECONDS_MIN,
          WATCHDOG_SECONDS_MAX,
          "supervisor-heartbeat-field",
        )}
        {field(
          "Stall timeout",
          "A sub-agent with no activity for this long is stopped and reported",
          stallValue,
          stallValid,
          `Stall timeout must be ${STALL_MINUTES_MIN}–${STALL_MINUTES_MAX} minutes`,
          "min",
          setStallDraft,
          "Stall timeout minutes",
          STALL_MINUTES_MIN,
          STALL_MINUTES_MAX,
          "supervisor-stall-field",
        )}
      </div>
      <div className="flex items-center gap-3">
        <p className="text-[10.5px] flex-1" style={{ color: styles.textTertiary }}>
          Defaults: 15s heartbeat · 5min stall. Stalled children are stopped, never left hanging.
        </p>
        <button
          onClick={onSave}
          disabled={!dirty || !heartbeatValid || !stallValid || save.isPending}
          aria-label="Save sub-agent supervision settings"
          className="h-8 px-3 rounded-[8px] text-[11px] font-bold shrink-0 disabled:opacity-50"
          style={{ background: withAlpha(styles.accent, 0.12), color: styles.accent }}
        >
          {save.isPending ? "Saving…" : "Save"}
        </button>
      </div>
    </section>
  );
}

/* ── Composition ──────────────────────────────────────────────────────────── */

/**
 * The sub-agent cards, in reading order (R58-d; R92-D3: the keys CARD
 * became the keys NOTE). Kept as a named export so tests (and any future
 * embedding) can mount the card stack directly.
 */
export function SubAgentsSection() {
  return (
    <div className="flex flex-col gap-4" data-subagents-section>
      {/* R92-D3: sub-agents ride the provider key pools — this note points
          at the one true key manager (the old paste-slot card is gone). */}
      <SubAgentKeysNote />
      <SubAgentModelCard />
      {/* ROUND-58 (R58-d): the parallelism limits MOVED here from the old
          Advanced tab — they govern exactly the children the cards above
          configure. */}
      <SubAgentParallelismCard />
      {/* ROUND-52 (R52-b): the supervisor knobs — the orchestration family's
          newest members (heartbeat + stall timeout). */}
      <SubAgentSupervisionCard />
    </div>
  );
}

/** The dedicated Sub-agents settings tab (?tab=subagents) — the single home
 * for everything sub-agent (R58-d; the Advanced tab no longer duplicates it). */
export function SubAgentsTab() {
  const styles = useThemeStyles();
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      {/* Clean page header — the cards below are the whole sub-agent story:
          keys (via the providers&apos; pools), model, parallelism, supervision. */}
      <div className="pb-1">
        <h2 className="text-[16px] font-black" style={{ color: styles.text }}>
          Sub-agents
        </h2>
        <p className="mt-1 text-[12px]" style={{ color: styles.textSecondary }}>
          Model, parallelism, and supervision for the agents your main agent delegates to — they
          share each provider&apos;s API key pool.
        </p>
      </div>
      <SubAgentsSection />
    </div>
  );
}

export default SubAgentsTab;
