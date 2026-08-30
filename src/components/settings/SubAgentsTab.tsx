import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { Activity, Check, Cpu, KeyRound, Plus, Trash2 } from "lucide-react";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { withAlpha } from "../dashboard/helpers";
import { isTauri } from "../../lib/sidecar";
import { filterModelsForPicker, useSettingsStore } from "../../lib/settings-store";
import {
  fetchKeyPool,
  fetchModelsCatalog,
  fetchOrchestrationSettings,
  removeKeyPoolSlot,
  setKeyPoolSlot,
  updateOrchestrationSettings,
  type KeyPoolSlot,
  type OrchestrationSettings,
} from "../../lib/api";

/**
 * SubAgentsTab — ROUND-43 (R43-5, owner directive):
 *
 * > "for the sub-agents I should create a dedicated section for their API keys
 * > and for their models, where I can paste in the API keys of all OpenRouter
 * > temporarily and also select a free model from there temporarily. These
 * > settings will be temporary ones… later on it will be completely removed."
 *
 * Two clearly-labeled TEMPORARY cards:
 *  1. Sub-agent OpenRouter keys — paste slots writing the EXISTING
 *     /providers/openrouter/keys/N pool routes. Slot 0 (the owner's primary
 *     key) is NEVER touched; the orchestrator already prefers pool slots for
 *     sub-agent traffic so parallel children don't compete with main chats.
 *  2. Sub-agent model — picker over the SERVED model catalog (GET
 *     /models/catalog — ROUND-47 R47-c2; the hand-copied 47-entry
 *     SUBAGENT_MODEL_CATALOG that used to live here is deleted), honoring
 *     the shared modelsFreeOnly pref, persisted as orchestration.subagentModel
 *     (null = "Inherits main model"). Only tool-capable models are
 *     selectable — sub-agents are mandated tool users (ROUND-39).
 */

const SUBAGENT_PROVIDER_ID = "openrouter";

/**
 * ROUND-53: the old copy told the PACKAGED app's owner to run `pnpm dev:full`
 * — dev-workflow advice shown in a desktop install. Mode-aware now: the
 * desktop app points at the connection banner's Restart engine action.
 */
const coreUnreachableHint = isTauri()
  ? "agent-core is not responding — if the connection banner is showing, use its Restart engine button, then reopen this tab."
  : "Agent core unreachable — start the app (or pnpm dev:full).";

/**
 * The three paste slots target pool slots 2, 3, 4 (slot 0 = the owner's
 * primary key is NEVER written from here). NOTE on numbering: pool slot 1
 * exists in the keyring's env-var space, but poolInfo's high-water mark only
 * tracks slots ≥ 2 — a slot-1-only pool row would be invisible to the masked
 * listing — so this UI follows the established pool convention of starting at
 * slot 2 (the same slots shown under Models & Providers → key pool).
 */
const SUBAGENT_KEY_SLOTS = [2, 3, 4] as const;
const MAX_POOL_SLOT = 31;

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
  subagentModel?: string | null;
  childWatchdogMs?: number;
  childStallTimeoutMs?: number;
}): Promise<OrchestrationSettings> {
  return updateOrchestrationSettings(patch);
}

/* ── Card 1: sub-agent API key paste slots ────────────────────────────────── */

function SubAgentKeysCard() {
  const styles = useThemeStyles();
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [extraDraft, setExtraDraft] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const poolQuery = useQuery({
    queryKey: ["key-pool", SUBAGENT_PROVIDER_ID],
    queryFn: () => fetchKeyPool(SUBAGENT_PROVIDER_ID),
  });
  const pool = poolQuery.data ?? [];
  const bySlot = new Map(pool.map((k) => [k.slot, k]));
  // Pool slots outside the three dedicated ones (e.g. keys added under
  // Models & Providers) still show here — same underlying pool.
  const extraSlots = pool
    .map((k) => k.slot)
    // ROUND-44 (VLM pass): start at 2 — slot 1 is the keyring's legacy
    // env-var slot and shows up in the pool listing as a keyless row; rendering
    // it as an add-row here produced the confusing 2,3,4,1,5 ordering.
    .filter((s) => s >= 2 && !(SUBAGENT_KEY_SLOTS as readonly number[]).includes(s))
    .sort((a, b) => a - b);
  const nextSlot = (() => {
    for (let s = 2; s <= MAX_POOL_SLOT; s++) {
      if (!bySlot.get(s)?.hasKey) return s;
    }
    return null;
  })();
  // The add-row only offers slots BEYOND the three dedicated paste slots —
  // rendering it for slot 2/3/4 would duplicate their aria-labels.
  const addableSlot =
    nextSlot !== null && !(SUBAGENT_KEY_SLOTS as readonly number[]).includes(nextSlot)
      ? nextSlot
      : null;

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["key-pool", SUBAGENT_PROVIDER_ID] });
    void queryClient.invalidateQueries({ queryKey: ["settings-providers"] });
  };

  const saveSlot = useMutation({
    mutationFn: ({ slot, value }: { slot: number; value: string }) =>
      setKeyPoolSlot(SUBAGENT_PROVIDER_ID, slot, value),
    onSuccess: (_data, vars) => {
      setDrafts((d) => ({ ...d, [vars.slot]: "" }));
      if (vars.slot === addableSlot) setExtraDraft("");
      setMsg(`Saved to pool slot ${vars.slot}.`);
      setTimeout(() => setMsg(null), 1500);
      invalidate();
    },
    onError: (err: Error) => setMsg(err.message),
  });

  const removeSlot = useMutation({
    mutationFn: (slot: number) => removeKeyPoolSlot(SUBAGENT_PROVIDER_ID, slot),
    onSuccess: (_data, slot) => {
      setMsg(`Removed pool slot ${slot}.`);
      setTimeout(() => setMsg(null), 1500);
      invalidate();
    },
    onError: (err: Error) => setMsg(err.message),
  });

  const slotRow = (slot: number) => {
    const info: KeyPoolSlot | undefined = bySlot.get(slot);
    const saved = info?.hasKey === true;
    const draft = drafts[slot] ?? "";
    return (
      <div
        key={slot}
        className="flex items-center gap-2 px-3 py-2 border-b last:border-b-0"
        style={{ borderColor: styles.borderSubtle }}
        data-subagent-key-slot={slot}
      >
        <span
          className="text-[11px] font-mono font-bold shrink-0"
          style={{ color: saved ? styles.text : styles.textTertiary }}
        >
          KEY SLOT {slot}
        </span>
        {saved ? (
          <>
            <span
              className="font-mono text-[11px] flex-1 min-w-0 truncate"
              style={{ color: styles.textSecondary }}
              title={`Pool slot ${slot} key stored (masked)`}
            >
              {info?.masked ?? "—"}
            </span>
            <button
              onClick={() => {
                if (window.confirm(`Remove the sub-agent key in pool slot ${slot}?`)) {
                  removeSlot.mutate(slot);
                }
              }}
              aria-label={`Remove pool slot ${slot} key`}
              title="Remove key"
              className="w-6 h-6 grid place-items-center rounded-md shrink-0"
              style={{ color: styles.textTertiary }}
              onMouseEnter={(e) => (e.currentTarget.style.background = withAlpha("#ef4444", 0.12))}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <Trash2 size={11} />
            </button>
          </>
        ) : (
          <>
            <input
              type="password"
              autoComplete="off"
              value={draft}
              onChange={(e) => setDrafts((d) => ({ ...d, [slot]: e.target.value }))}
              placeholder="paste an OpenRouter key (sk-or-…)"
              aria-label={`Sub-agent key for pool slot ${slot}`}
              className="h-8 flex-1 min-w-0 rounded-[8px] border-[1.5px] px-2.5 font-mono text-[11px] outline-none"
              style={{ background: styles.bg, borderColor: styles.border, color: styles.text }}
            />
            <button
              onClick={() => draft.trim() && saveSlot.mutate({ slot, value: draft.trim() })}
              disabled={!draft.trim() || saveSlot.isPending}
              aria-label={`Save key to pool slot ${slot}`}
              className="h-8 px-3 rounded-[8px] text-[11px] font-bold shrink-0 disabled:opacity-50"
              style={{ background: withAlpha(styles.accent, 0.12), color: styles.accent }}
            >
              Save
            </button>
          </>
        )}
      </div>
    );
  };

  return (
    <section
      className="rounded-[16px] border-[1.5px] p-4 flex flex-col gap-2.5"
      style={{ background: styles.card, borderColor: styles.border }}
      aria-label="Sub-agent OpenRouter keys (temporary)"
    >
      <div className="flex items-center gap-2 flex-wrap">
        <KeyRound size={13} style={{ color: styles.accent, opacity: 0.8 }} />
        <span className="text-[13px] font-bold" style={{ color: styles.text }}>
          Sub-agent OpenRouter keys <span style={{ color: styles.textTertiary }}>(temporary)</span>
        </span>
        <span className="flex-1" />
        {msg && (
          <span
            className="text-[11px] font-bold"
            style={{ color: saveSlot.isError || removeSlot.isError ? "#ef4444" : "#22c55e" }}
          >
            {msg}
          </span>
        )}
      </div>
      <p className="text-[11px] leading-relaxed" style={{ color: styles.textSecondary }}>
        Sub-agent traffic prefers these keys so parallel agents don't compete with your main chats.
        Paste up to three OpenRouter keys — they go to the provider's dedicated pool slots (never
        your primary key, slot&nbsp;0). ROUND-44: keys placed in{" "}
        <span className="font-mono" style={{ color: styles.text }}>credentials.txt</span> as{" "}
        <span className="font-mono" style={{ color: styles.text }}>OPENROUTER_SUB1..3_KEY</span>{" "}
        (or added by the launcher) land here automatically — nothing to paste by hand.
      </p>
      {poolQuery.isError ? (
        <p className="text-[11px]" style={{ color: "#ef4444" }} role="alert">
          {coreUnreachableHint} to manage sub-agent keys.
        </p>
      ) : (
        <div className="rounded-[10px] border-[1.5px] overflow-hidden" style={{ borderColor: styles.border }}>
          {SUBAGENT_KEY_SLOTS.map(slotRow)}
          {extraSlots.map(slotRow)}
          {addableSlot !== null && (
            <div
              className="flex items-center gap-2 px-3 py-2 border-t"
              style={{ borderColor: styles.borderSubtle, background: withAlpha(styles.accent, 0.03) }}
            >
              <span className="text-[11px] font-mono font-bold shrink-0" style={{ color: styles.textTertiary }}>
                KEY SLOT {addableSlot}
              </span>
              <input
                type="password"
                autoComplete="off"
                value={extraDraft}
                onChange={(e) => setExtraDraft(e.target.value)}
                placeholder="another OpenRouter key (optional)"
                aria-label={`Sub-agent key for pool slot ${addableSlot}`}
                className="h-8 flex-1 min-w-0 rounded-[8px] border-[1.5px] px-2.5 font-mono text-[11px] outline-none"
                style={{ background: styles.bg, borderColor: styles.border, color: styles.text }}
              />
              <button
                onClick={() =>
                  extraDraft.trim() && saveSlot.mutate({ slot: addableSlot, value: extraDraft.trim() })
                }
                disabled={!extraDraft.trim() || saveSlot.isPending}
                aria-label={`Save key to pool slot ${addableSlot}`}
                className="h-8 px-3 rounded-[8px] text-[11px] font-bold flex items-center gap-1 shrink-0 disabled:opacity-50"
                style={{ background: withAlpha(styles.accent, 0.12), color: styles.accent }}
              >
                <Plus size={11} strokeWidth={2.5} /> Add slot
              </button>
            </div>
          )}
        </div>
      )}
      <p className="text-[10.5px]" style={{ color: styles.textTertiary }}>
        Same pool as Models&nbsp;&amp;&nbsp;Providers → key pool; slot&nbsp;0 (your primary key) is
        never written here. Temporary — this section will be removed in a later round.
      </p>
    </section>
  );
}

/* ── Card 2: sub-agent model picker ───────────────────────────────────────── */

function SubAgentModelCard() {
  const styles = useThemeStyles();
  const queryClient = useQueryClient();
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
    mutationFn: (modelId: string | null) => saveSubagentSettings({ subagentModel: modelId }),
    onSuccess: (_data, modelId) => {
      setMsg(modelId === null ? "Cleared — inherits main model." : "Saved.");
      setTimeout(() => setMsg(null), 1500);
      void queryClient.invalidateQueries({ queryKey: ["orchestration-settings"] });
    },
    onError: (err: Error) => setMsg(err.message),
  });

  const settingsPending = settingsQuery.isLoading || settingsQuery.data === undefined;
  if (settingsQuery.isError) {
    return (
      <section
        className="rounded-[16px] border-[1.5px] p-4"
        style={{ background: styles.card, borderColor: styles.border }}
        aria-label="Sub-agent model (temporary)"
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
        aria-label="Sub-agent model (temporary)"
      >
        <div className="flex items-center gap-2">
          <Cpu size={13} style={{ color: styles.accent, opacity: 0.8 }} />
          <span className="text-[13px] font-bold" style={{ color: styles.text }}>
            Sub-agent model <span style={{ color: styles.textTertiary }}>(temporary)</span>
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
        aria-label="Sub-agent model (temporary)"
      >
        <span className="text-[12px] font-mono" style={{ color: styles.textTertiary }}>
          {settingsPending || settings === undefined ? "loading sub-agent model settings…" : "loading the model catalog…"}
        </span>
      </section>
    );
  }

  const selected = settings.subagentModel;
  const selectedEntry = catalog.models.find((m) => m.modelId === selected);

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
      aria-label="Sub-agent model (temporary)"
    >
      <div className="flex items-center gap-2 flex-wrap">
        <Cpu size={13} style={{ color: styles.accent, opacity: 0.8 }} />
        <span className="text-[13px] font-bold" style={{ color: styles.text }}>
          Sub-agent model <span style={{ color: styles.textTertiary }}>(temporary)</span>
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
            {selectedEntry?.displayName ?? selected}
            <span className="font-mono text-[11px] ml-1.5" style={{ color: styles.textTertiary }}>
              {selected}
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
            const isSelected = selected === m.modelId;
            const recommended = m.modelId === recommendedId;
            return (
              <button
                key={m.modelId}
                onClick={() => !disabled && saveModel.mutate(m.modelId)}
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
      <p className="text-[10.5px]" style={{ color: styles.textTertiary }}>
        Applies to every delegated sub-agent turn (delegate_task + retries). Parallelism limits stay
        in{" "}
        <Link to="/settings?tab=advanced" className="font-bold underline" style={{ color: styles.accent }}>
          Advanced
        </Link>
        . Temporary — this section will be removed in a later round.
      </p>
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
      setTimeout(() => setMsg(null), 1500);
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

/** The cards (reused by the Advanced tab until the sidebar gains a
 * dedicated Sub-agents section entry). */
export function SubAgentsSection() {
  const styles = useThemeStyles();
  return (
    <div className="flex flex-col gap-4" data-subagents-section>
      <p
        className="rounded-[10px] border-[1.5px] px-3 py-2 text-[11px] leading-relaxed"
        style={{
          borderColor: withAlpha(styles.accent, 0.35),
          background: withAlpha(styles.accent, 0.05),
          color: styles.textSecondary,
        }}
      >
        <strong style={{ color: styles.text }}>Temporary setup.</strong> Paste spare OpenRouter keys
        and pick a free model for sub-agent traffic — parallel agents then run on their own keys and
        model instead of competing with your main chats. This whole section will be removed in a
        later round.
      </p>
      <SubAgentKeysCard />
      <SubAgentModelCard />
      {/* ROUND-52 (R52-b): the supervisor knobs — the orchestration family's
          newest members (heartbeat + stall timeout; NOT temporary — they
          stay when the temporary keys/model cards go). */}
      <SubAgentSupervisionCard />
    </div>
  );
}

/** The dedicated Sub-agents settings tab (?tab=subagents). */
export function SubAgentsTab() {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <SubAgentsSection />
    </div>
  );
}

export default SubAgentsTab;
