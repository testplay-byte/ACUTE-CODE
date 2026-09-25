import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { Activity, Check, Cpu, KeyRound, Workflow } from "lucide-react";
import { useTimeoutClear } from "../../hooks/use-timeout-clear";
import { useThemeStyles } from "../../lib/use-theme-styles";
// R100-E2: the label-tier heading primitive (TOKENS §2 — THE one kicker).
import { Kicker } from "../ui/Kicker";
// R126-3f-3: the card grid rides the SectionCard clay primitive (the local
// rounded-2xl border-[1.5px] card spellings are retired).
import { SectionCard } from "../ui/SectionCard";
import { isTauri } from "../../lib/sidecar";
import { isFreeModelEntry } from "../../lib/settings-store";
import {
  fetchConfiguredModels,
  fetchOrchestrationSettings,
  fetchProviders,
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
 * API keys. The parallelism and supervision cards stay as they were.
 *
 * ROUND-93 (R93-A9, owner directive: "in the sub-agent models only those
 * models should be shown which are available, not the other ones"): the
 * model picker's PRIMARY — and only — list is now the user's CONFIGURED
 * models (GET /models/configured, hidden rows excluded). The static
 * OpenRouter catalog (GET /models/catalog) that used to fill this picker is
 * REMOVED from this surface entirely — models are added in exactly one
 * place (Models & Providers), and "available" here means exactly the rows
 * that live there. Picking still writes the same provider-scoped
 * {providerId, modelId} pair into orchestration.subagentModel (the R82
 * wire, unchanged); only the SOURCE of the rows changed. The inherit row
 * keeps its exact old behavior.
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
    /* R126-3f-3: the note card = the SectionCard clay card. */
    <SectionCard
      className="p-4 flex items-center gap-3 flex-wrap"
      ariaLabel="Sub-agent API keys"
      testId="subagent-keys-note"
    >
      <span
        /* R126-3f-3: the ClayIconChip recipe (bg-accent-tint + the
         * text-accent-deep glyph). */
        className="w-9 h-9 shrink-0 rounded-lg grid place-items-center bg-accent-tint text-accent-deep"
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
        className="h-8 px-3 rounded-lg text-[11px] font-semibold flex items-center gap-1.5 shrink-0 bg-accent-tint text-accent-deep transition-colors duration-100 hover:bg-hover active:scale-[0.98]"
      >
        <KeyRound size={11} /> Manage keys
      </Link>
    </SectionCard>
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

  // ROUND-93 (R93-A9, owner directive: "in the sub-agent models only
  // those models should be shown which are available, not the other ones"):
  // the picker's PRIMARY — and only — list is the user's CONFIGURED model
  // rows across all providers (GET /models/configured), hidden rows
  // excluded. The static OpenRouter catalog (GET /models/catalog) that used
  // to fill this picker is REMOVED from this surface entirely — models are
  // added in exactly one place (Models & Providers), and "available" here
  // means exactly the rows that live there. StaleTime 60s: rows change only
  // through the Models & Providers page, whose mutations invalidate this
  // family. No auto-retry — an honest error card with a retry button beats a
  // silent retry loop.
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

  // R93-A9: provider display names for the row chips (GET /providers — the
  // SAME ["settings-providers"] cache the Models & Providers tab and the
  // agent dialog use, so CRUD there refreshes here too). Purely cosmetic:
  // while loading, on failure, or for an unknown id the chips fall back to
  // the raw providerId and the picker keeps working.
  const providersQuery = useQuery({
    queryKey: ["settings-providers"],
    queryFn: fetchProviders,
    staleTime: 60 * 1000,
    retry: false,
  });

  const saveModel = useMutation({
    mutationFn: (ref: SubagentModelRef | null) => saveSubagentSettings({ subagentModel: ref }),
    onSuccess: (_data, ref) => {
      setMsg(ref === null ? "Cleared — inherits main model." : "Saved.");
      resetAfter(() => setMsg(null), 1500);
      void queryClient.invalidateQueries({ queryKey: ["orchestration-settings"] });
    },
    onError: (err: Error) => setMsg(err.message),
  });

  const settingsPending = settingsQuery.isLoading || settingsQuery.data === undefined;
  if (settingsQuery.isError) {
    return (
      <SectionCard className="p-4" ariaLabel="Sub-agent model">
        <p className="text-[11px] text-danger-deep" role="alert">
          {coreUnreachableHint} to pick a sub-agent model.
        </p>
      </SectionCard>
    );
  }
  // R93-A9: honest configured-rows failure — NO hidden fallback (the old
  // catalog-failure contract, moved onto the query that now feeds the whole
  // picker). The backend's own message + a retry affordance; the picker
  // simply doesn't render until the truth is available.
  if (configuredQuery.isError) {
    return (
      <SectionCard className="p-4 flex flex-col gap-2.5" ariaLabel="Sub-agent model">
        <div className="flex items-center gap-2">
          <Cpu size={13} className="text-accent-deep" />
          <span className="text-[13px] font-semibold" style={{ color: styles.text }}>
            Sub-agent model
          </span>
        </div>
        <p className="text-[11px] text-danger-deep" role="alert">
          Configured models unavailable — {configuredQuery.error instanceof Error ? configuredQuery.error.message : String(configuredQuery.error)}
        </p>
        <div>
          <button
            onClick={() => void configuredQuery.refetch()}
            aria-label="Retry loading the configured models"
            /* R126-3f-3: the family's error-card Retry spelling (the
             * outlined-danger leg — the SkillsTab/PromptsTab/3f-1
             * SettingsLoadErrorCard contract; the accent-tint action tier
             * never rides an error path). */
            className="h-8 px-3 rounded-lg text-[11px] font-semibold border border-danger-deep text-danger-deep transition-colors duration-100 hover:bg-hover active:scale-[0.98]"
          >
            Retry
          </button>
        </div>
      </SectionCard>
    );
  }

  const settings = settingsQuery.data;
  const configured = configuredQuery.data;
  if (settingsPending || settings === undefined || configured === undefined) {
    return (
      <SectionCard className="p-4" ariaLabel="Sub-agent model">
        <span className="text-[12px] font-mono" style={{ color: styles.textTertiary }}>
          {settingsPending || settings === undefined ? "loading sub-agent model settings…" : "loading your configured models…"}
        </span>
      </SectionCard>
    );
  }

  const selected = settings.subagentModel;
  // R93-A9: THE picker rows — every configured, not-hidden model row the user
  // curated in Models & Providers (the hide toggle is the "keep it out of my
  // pickers" contract). No free-only segmentation here: the user's own list
  // is short by construction and every row on it is fair game.
  const rows: ProviderModelConfig[] = configured.filter((m) => m.hidden !== true);
  // The RUNNING ON strip's display name — resolved from the configured rows
  // when the saved ref still matches one (a deleted row degrades honestly to
  // the raw modelId).
  const selectedRow = configured.find(
    (m) => selected !== null && m.providerId === selected.providerId && m.modelId === selected.modelId,
  );

  // R93-A9: the row chip's provider label — the registry's display name
  // when it resolves, the raw id otherwise (cosmetic only, fails soft).
  const providerChip = (id: string): string =>
    providersQuery.data?.find((p) => p.id === id)?.name ?? id;

  return (
    <SectionCard className="p-4 flex flex-col gap-2.5" ariaLabel="Sub-agent model">
      <div className="flex items-center gap-2 flex-wrap">
        <Cpu size={13} className="text-accent-deep" />
        <span className="text-[13px] font-semibold" style={{ color: styles.text }}>
          Sub-agent model
        </span>
        <span className="flex-1" />
        {msg && (
          <span
            className={`text-[11px] font-medium ${
              saveModel.isError ? "text-danger-deep" : "text-success-deep"
            }`}
          >
            {msg}
          </span>
        )}
      </div>

      {/* Current override state */}
      <div
        /* R126-3f-3: the RUNNING-ON strip = the well (resting) or the
         * accent-tint + accentDeep rim (an override is set). */
        className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${
          selected ? "border-accent-deep bg-accent-tint" : "border-clay-rim bg-well"
        }`}
      >
        <span className="text-[11px] font-medium shrink-0" style={{ color: styles.textTertiary }}>
          RUNNING ON
        </span>
        {selected === null ? (
          <span className="text-[12px] font-medium" style={{ color: styles.textSecondary }}>
            Inherits main model
          </span>
        ) : (
          <span className="text-[12px] font-medium min-w-0 truncate" style={{ color: styles.text }}>
            {/* R93-A9: the display name comes from the configured rows now
                (the catalog lookup is gone); a deleted/unknown row degrades
                honestly to the raw id. */}
            {selectedRow && selectedRow.displayName ? selectedRow.displayName : selected.modelId}
            <span className="font-mono text-[11px] ml-1.5" style={{ color: styles.textTertiary }}>
              {/* ROUND-82: the provider chip — the child turns route to THIS
                  provider (the R82 override wire); the old bare id left the
                  routing target invisible. */}
              {selected.providerId} · {selected.modelId}
            </span>
          </span>
        )}
      </div>

      <div
        /* R126-3f-3: the rim hairline container (TOKENS §5). */
        className="rounded-lg border border-clay-rim overflow-hidden"
      >
        {/* Inherit row */}
        <button
          onClick={() => saveModel.mutate(null)}
          aria-label="Inherit the main model for sub-agents"
          /* R126-3f-3: the selected row = the selection grammar
           * (bg-accent-tint, TOKENS §10); the hairline on the class leg. */
          className={`w-full flex items-center gap-2 px-3 py-2 border-b border-line text-left ${
            selected === null ? "bg-accent-tint" : ""
          }`}
        >
          <span className="text-[12px] font-medium" style={{ color: styles.text }}>
            Inherits main model <span style={{ color: styles.textTertiary, fontWeight: 400 }}>(default)</span>
          </span>
          <span className="flex-1" />
          {selected === null && <Check size={12} className="text-accent-deep" />}
        </button>

        {rows.length === 0 ? (
          /* R93-A9: zero configured rows — the honest pointer to the ONE
             place models are added (never a fallback catalog list). */
          <div className="flex items-center gap-2 px-3 py-2.5 flex-wrap" data-testid="subagent-no-models-hint">
            <span className="text-[11px] flex-1 min-w-[200px]" style={{ color: styles.textSecondary }}>
              No models configured — add them in Settings → Models &amp; Providers.
            </span>
            <Link
              to="/settings?tab=api"
              aria-label="Open Models and Providers to add models"
              className="h-8 px-3 rounded-lg text-[11px] font-semibold flex items-center gap-1.5 shrink-0 bg-accent-tint text-accent-deep transition-colors duration-100 hover:bg-hover active:scale-[0.98]"
            >
              Add models
            </Link>
          </div>
        ) : (
          <div className="max-h-64 overflow-y-auto">
            {rows.map((m) => {
              // Tri-state tools: explicit false disables (the honest gate);
              // null (unknown) stays pickable — the row's own Test button
              // (Models & Providers) is the ground truth.
              const disabled = m.supportsTools === false;
              // ROUND-82: provider-scoped selection key — picking a row
              // writes the explicit {providerId, modelId} pair and the R82
              // orchestrator override routes the child turns to THAT
              // provider.
              const isSelected =
                selected !== null && selected.providerId === m.providerId && selected.modelId === m.modelId;
              return (
                <button
                  key={`${m.providerId}:${m.modelId}`}
                  onClick={() =>
                    !disabled && saveModel.mutate({ providerId: m.providerId, modelId: m.modelId })
                  }
                  disabled={disabled}
                  aria-label={
                    disabled
                      ? `${m.modelId} on ${m.providerId} (unavailable)`
                      : `Use ${m.modelId} on ${m.providerId} for sub-agents`
                  }
                  title={disabled ? "marked as not tool-capable" : `${m.providerId} · ${m.modelId}`}
                  className={`w-full flex items-center gap-2 px-3 py-2 border-b border-line last:border-b-0 text-left disabled:cursor-not-allowed ${
                    isSelected ? "bg-accent-tint" : ""
                  }`}
                  style={{ opacity: disabled ? 0.55 : 1 }}
                >
                  <span className="min-w-0 flex-1 flex items-center gap-1.5 flex-wrap">
                    <span
                      className="text-[12px] font-medium truncate"
                      style={{ color: disabled ? styles.textTertiary : styles.text }}
                    >
                      {m.displayName || m.modelId}
                    </span>
                    <span
                      className="shrink-0 px-1.5 py-0.5 rounded-full font-mono text-[10px] font-medium bg-badge-neutral text-badge-neutral-fg"
                      title="The provider the child turns route to"
                    >
                      {providerChip(m.providerId)}
                    </span>
                    {isFreeModelEntry(m) && (
                      <span
                        className="text-[10px] font-medium uppercase tracking-wider rounded-full px-1.5 py-0.5 bg-badge-success text-badge-success-fg"
                      >
                        free
                      </span>
                    )}
                  </span>
                  <span className="font-mono text-[10px] shrink-0 truncate max-w-[45%]" style={{ color: styles.textTertiary }}>
                    {m.modelId}
                  </span>
                  {m.contextWindow !== null && (
                    <span className="text-[10px] shrink-0 tabular-nums" style={{ color: styles.textTertiary }}>
                      {formatCtx(m.contextWindow)}
                    </span>
                  )}
                  {disabled ? (
                    <span className="text-[10px] font-medium shrink-0 text-danger-deep">
                      no tool calling
                    </span>
                  ) : isSelected ? (
                    <Check size={12} className="text-accent-deep" />
                  ) : null}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <p className="text-[11px]" style={{ color: styles.textTertiary }}>
        Exactly the models configured in Models &amp; Providers (hidden rows excluded) — sub-agent turns
        route to the row&apos;s provider. Applies to every delegated sub-agent turn (delegate_task + retries);
        parallelism and supervision live in the cards below.
      </p>
    </SectionCard>
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
      <SectionCard className="p-4" ariaLabel="Sub-agent parallelism">
        <p className="text-[11px] text-danger-deep" role="alert">
          {coreUnreachableHint} to tune sub-agent parallelism.
        </p>
      </SectionCard>
    );
  }
  const current = settingsQuery.data;
  if (settingsQuery.isLoading || current === undefined) {
    return (
      <SectionCard className="p-4" ariaLabel="Sub-agent parallelism">
        <span className="text-[12px] font-mono" style={{ color: styles.textTertiary }}>
          loading parallelism settings…
        </span>
      </SectionCard>
    );
  }

  const stepper = (label: string, hint: string, field: "maxParallel" | "perKeyLimit", min: number, max: number, inputLabel: string, testId: string) => (
    <div className="flex items-center gap-3 flex-wrap" data-testid={testId}>
      <div className="min-w-[220px] flex-1">
        <div className="text-[13px] font-semibold" style={{ color: styles.text }}>{label}</div>
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
            /* R126-3f-3: the stepper buttons = the well + rim (TOKENS §10). */
            className="w-8 h-8 rounded-lg grid place-items-center border border-clay-rim bg-well text-[13px] font-semibold text-muted shrink-0 transition-colors duration-100 hover:bg-hover active:scale-[0.98]"
          >
            {delta > 0 ? "+" : "−"}
          </button>
        ))}
        <span
          className="w-14 text-center text-[13px] font-semibold tabular-nums rounded-lg py-1 bg-accent-tint text-accent-deep"
          aria-label={inputLabel}
        >
          {draft[field] ?? current[field]}
        </span>
      </div>
    </div>
  );

  const dirty = draft.maxParallel !== undefined || draft.perKeyLimit !== undefined;

  return (
    <SectionCard className="p-4 flex flex-col gap-4" ariaLabel="Sub-agent parallelism">
      <div className="flex items-center gap-2 flex-wrap">
        <Workflow size={13} className="text-accent-deep" />
        <span className="text-[13px] font-semibold" style={{ color: styles.text }}>
          Sub-agent parallelism
        </span>
        <span className="flex-1" />
        {msg && (
          <span
            className={`text-[11px] font-medium ${
              update.isError ? "text-danger-deep" : "text-success-deep"
            }`}
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
        <p className="text-[11px] flex-1" style={{ color: styles.textTertiary }}>
          Each key carries at most this many children at once; extra pool keys raise the ceiling.
        </p>
        <button
          onClick={() => update.mutate(draft)}
          disabled={!dirty || update.isPending}
          aria-label="Save sub-agent parallelism settings"
          className="h-8 px-3 rounded-lg text-[11px] font-semibold shrink-0 bg-accent-tint text-accent-deep transition-colors duration-100 hover:bg-hover active:scale-[0.98] disabled:opacity-50"
        >
          {update.isPending ? "Saving…" : "Save"}
        </button>
      </div>
    </SectionCard>
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
      <SectionCard className="p-4" ariaLabel="Sub-agent supervision">
        <p className="text-[11px] text-danger-deep" role="alert">
          {coreUnreachableHint} to tune sub-agent supervision.
        </p>
      </SectionCard>
    );
  }
  const current = settingsQuery.data;
  if (settingsQuery.isLoading || current === undefined) {
    return (
      <SectionCard className="p-4" ariaLabel="Sub-agent supervision">
        <span className="text-[12px] font-mono" style={{ color: styles.textTertiary }}>
          loading supervision settings…
        </span>
      </SectionCard>
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
        <div className="text-[13px] font-semibold" style={{ color: styles.text }}>
          {label}
        </div>
        <div className="text-[11px]" style={{ color: styles.textTertiary }}>
          {hint}
        </div>
        {!valid ? (
          <div
            className="text-[11px] font-medium text-danger-deep"
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
          /* R126-3f-3: THE WELL + rim; the invalid state swaps the rim for
           * the danger outline (§11). */
          className={`w-20 h-8 rounded-lg border px-2.5 font-mono text-[11px] outline-none text-right bg-well text-ink ${
            !valid ? "border-danger-deep" : "border-clay-rim"
          }`}
        />
        <span className="text-[11px] font-mono shrink-0" style={{ color: styles.textTertiary }}>
          {suffix}
        </span>
      </div>
    </div>
  );

  return (
    <SectionCard className="p-4 flex flex-col gap-2.5" ariaLabel="Sub-agent supervision">
      <div className="flex items-center gap-2 flex-wrap">
        <Activity size={13} className="text-accent-deep" />
        <span className="text-[13px] font-semibold" style={{ color: styles.text }}>
          Sub-agent supervision
        </span>
        <span className="flex-1" />
        {msg && (
          <span
            className={`text-[11px] font-medium ${
              msgIsError ? "text-danger-deep" : "text-success-deep"
            }`}
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
        <p className="text-[11px] flex-1" style={{ color: styles.textTertiary }}>
          Defaults: 15s heartbeat · 5min stall. Stalled children are stopped, never left hanging.
        </p>
        <button
          onClick={onSave}
          disabled={!dirty || !heartbeatValid || !stallValid || save.isPending}
          aria-label="Save sub-agent supervision settings"
          className="h-8 px-3 rounded-lg text-[11px] font-semibold shrink-0 bg-accent-tint text-accent-deep transition-colors duration-100 hover:bg-hover active:scale-[0.98] disabled:opacity-50"
        >
          {save.isPending ? "Saving…" : "Save"}
        </button>
      </div>
    </SectionCard>
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
        <Kicker className="mb-1">Agents &amp; Skills</Kicker>
        <h2 className="text-[13px] font-semibold text-ink">Sub-agents</h2>
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
