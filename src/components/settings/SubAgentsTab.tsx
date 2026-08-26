import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { Check, Cpu, KeyRound, Plus, Trash2 } from "lucide-react";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { withAlpha } from "../dashboard/helpers";
import { filterModelsForPicker, useSettingsStore } from "../../lib/settings-store";
import {
  fetchKeyPool,
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
 *  2. Sub-agent model — picker over the wave-1 free catalog, honoring the
 *     shared modelsFreeOnly pref, persisted as orchestration.subagentModel
 *     (null = "Inherits main model"). Only tool-capable models are
 *     selectable — sub-agents are mandated tool users (ROUND-39).
 */

const SUBAGENT_PROVIDER_ID = "openrouter";

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

/** Mirrors agent-core SUBAGENT_DEFAULT_MODEL_ID (the browser bundle can't
 * import the sidecar package — duplicate kept deliberately, like wave-1's
 * isFreeModelEntry). */
const SUBAGENT_RECOMMENDED_ID = "nvidia/nemotron-3.5-lightning:free";

/**
 * Frontend copy of the wave-1 model catalog (agent-core storage/models.ts —
 * 18 free + 28 paid, recommended order first). The backend validates
 * subagentModel against the same catalog, so this list is exactly the set
 * the picker can persist. `tools` = supportsTools (tool-less entries are
 * rendered but disabled).
 */
const SUBAGENT_MODEL_CATALOG = [
  { id: "z-ai/glm-5.2:free", name: "Z.ai: GLM 5.2", ctx: 256000, free: true, tools: true },
  { id: "minimax/minimax-m3:free", name: "MiniMax: MiniMax M3", ctx: 1048576, free: true, tools: true },
  { id: "thinkingmachines/inkling-small:free", name: "Thinking Machines: Inkling Small", ctx: 1048576, free: true, tools: true },
  { id: "nvidia/nemotron-3.5-lightning:free", name: "NVIDIA: Nemotron 3.5 Lightning", ctx: 1000000, free: true, tools: true },
  { id: "poolside/laguna-s-2.1:free", name: "Poolside: Laguna S 2.1", ctx: 262144, free: true, tools: true },
  { id: "cohere/north-mini-code:free", name: "Cohere: North Mini Code", ctx: 256000, free: true, tools: true },
  { id: "openrouter/free", name: "Free Models Router", ctx: 200000, free: true, tools: true },
  { id: "dots-studio/dots-3-note-preview:free", name: "Dots Studio: Dots3-Note Preview", ctx: 512000, free: true, tools: true },
  { id: "google/gemma-4-26b-a4b-it:free", name: "Google: Gemma 4 26B A4B", ctx: 262144, free: true, tools: true },
  { id: "google/gemma-4-31b-it:free", name: "Google: Gemma 4 31B", ctx: 262144, free: true, tools: true },
  { id: "liquid/lfm-2.5-2.6b:free", name: "LiquidAI: LFM2.5-2.6B", ctx: 65536, free: true, tools: true },
  { id: "minimax/minimax-m2.7:free", name: "MiniMax: MiniMax M2.7", ctx: 196608, free: true, tools: true },
  { id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", name: "NVIDIA: Nemotron 3 Nano Omni", ctx: 256000, free: true, tools: true },
  { id: "nvidia/nemotron-3-super-120b-a12b:free", name: "NVIDIA: Nemotron 3 Super", ctx: 262144, free: true, tools: true },
  { id: "nvidia/nemotron-3-ultra-550b-a55b:free", name: "NVIDIA: Nemotron 3 Ultra", ctx: 1000000, free: true, tools: true },
  { id: "nvidia/nemotron-3.5-content-safety:free", name: "NVIDIA: Nemotron 3.5 Content Safety", ctx: 128000, free: true, tools: false },
  { id: "poolside/laguna-xs-2.1:free", name: "Poolside: Laguna XS 2.1", ctx: 262144, free: true, tools: true },
  { id: "thinkingmachines/inkling:free", name: "Thinking Machines: Inkling", ctx: 1048576, free: true, tools: true },
  { id: "anthropic/claude-opus-4.5", name: "Anthropic: Claude Opus 4.5", ctx: 200000, free: false, tools: true },
  { id: "anthropic/claude-sonnet-4.5", name: "Anthropic: Claude Sonnet 4.5", ctx: 1000000, free: false, tools: true },
  { id: "anthropic/claude-haiku-4.5", name: "Anthropic: Claude Haiku 4.5", ctx: 200000, free: false, tools: true },
  { id: "openai/gpt-5.2", name: "OpenAI: GPT-5.2", ctx: 400000, free: false, tools: true },
  { id: "openai/gpt-5.1", name: "OpenAI: GPT-5.1", ctx: 400000, free: false, tools: true },
  { id: "openai/gpt-5-mini", name: "OpenAI: GPT-5 Mini", ctx: 400000, free: false, tools: true },
  { id: "openai/gpt-5-nano", name: "OpenAI: GPT-5 Nano", ctx: 400000, free: false, tools: true },
  { id: "openai/o4-mini", name: "OpenAI: o4 Mini", ctx: 200000, free: false, tools: true },
  { id: "openai/o3", name: "OpenAI: o3", ctx: 200000, free: false, tools: true },
  { id: "openai/gpt-4.1", name: "OpenAI: GPT-4.1", ctx: 1047576, free: false, tools: true },
  { id: "openai/gpt-4o", name: "OpenAI: GPT-4o", ctx: 128000, free: false, tools: true },
  { id: "openai/gpt-4o-mini", name: "OpenAI: GPT-4o-mini", ctx: 128000, free: false, tools: true },
  { id: "google/gemini-3.1-pro-preview", name: "Google: Gemini 3.1 Pro Preview", ctx: 1048576, free: false, tools: true },
  { id: "google/gemini-3.7-flash", name: "Google: Gemini 3.7 Flash", ctx: 1048576, free: false, tools: true },
  { id: "google/gemini-2.5-pro", name: "Google: Gemini 2.5 Pro", ctx: 1048576, free: false, tools: true },
  { id: "google/gemini-2.5-flash", name: "Google: Gemini 2.5 Flash", ctx: 1048576, free: false, tools: true },
  { id: "x-ai/grok-4.6", name: "xAI: Grok 4.6", ctx: 500000, free: false, tools: true },
  { id: "x-ai/grok-build-0.1", name: "xAI: Grok Build 0.1", ctx: 256000, free: false, tools: true },
  { id: "deepseek/deepseek-v3.2", name: "DeepSeek: DeepSeek V3.2", ctx: 163840, free: false, tools: true },
  { id: "deepseek/deepseek-r1", name: "DeepSeek: R1", ctx: 64000, free: false, tools: true },
  { id: "qwen/qwen3-max", name: "Qwen: Qwen3 Max", ctx: 262144, free: false, tools: true },
  { id: "qwen/qwen3-coder", name: "Qwen: Qwen3 Coder 480B A35B", ctx: 262144, free: false, tools: true },
  { id: "moonshotai/kimi-k2-thinking", name: "MoonshotAI: Kimi K2 Thinking", ctx: 262144, free: false, tools: true },
  { id: "moonshotai/kimi-k2", name: "MoonshotAI: Kimi K2 0711", ctx: 131072, free: false, tools: true },
  { id: "z-ai/glm-4.6", name: "Z.ai: GLM 4.6", ctx: 204800, free: false, tools: true },
  { id: "minimax/minimax-m2.7", name: "MiniMax: MiniMax M2.7", ctx: 204800, free: false, tools: true },
  { id: "meta-llama/llama-4-maverick", name: "Meta: Llama 4 Maverick", ctx: 1048576, free: false, tools: true },
  { id: "mistralai/mistral-large-2512", name: "Mistral: Mistral Large 3 2512", ctx: 262144, free: false, tools: true },
] as const;

function formatCtx(ctx: number): string {
  return ctx >= 1_000_000 ? `${Math.round(ctx / 1_048_576)}M` : `${Math.round(ctx / 1000)}K`;
}

/**
 * The orchestration payload widened with the R43-5 field. api.ts's
 * OrchestrationSettings interface is owned by another wave — the runtime
 * payload already carries subagentModel, so this local widening is honest
 * and conflict-free.
 */
type SubagentOrchestration = OrchestrationSettings & { subagentModel: string | null };

async function fetchSubagentSettings(): Promise<SubagentOrchestration> {
  return (await fetchOrchestrationSettings()) as SubagentOrchestration;
}

async function saveSubagentSettings(patch: {
  maxParallel?: number;
  perKeyLimit?: number;
  subagentModel?: string | null;
}): Promise<SubagentOrchestration> {
  return (await updateOrchestrationSettings(
    patch as Partial<OrchestrationSettings>,
  )) as SubagentOrchestration;
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
    .filter((s) => s > 0 && !(SUBAGENT_KEY_SLOTS as readonly number[]).includes(s))
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
        your primary key, slot&nbsp;0).
      </p>
      {poolQuery.isError ? (
        <p className="text-[11px]" style={{ color: "#ef4444" }} role="alert">
          Agent core unreachable — start the app (or pnpm dev:full) to manage sub-agent keys.
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

  if (settingsQuery.isLoading || settingsQuery.data === undefined) {
    return (
      <section
        className="rounded-[16px] border-[1.5px] p-4"
        style={{ background: styles.card, borderColor: styles.border }}
        aria-label="Sub-agent model (temporary)"
      >
        <span className="text-[12px] font-mono" style={{ color: styles.textTertiary }}>
          loading sub-agent model settings…
        </span>
      </section>
    );
  }
  if (settingsQuery.isError) {
    return (
      <section
        className="rounded-[16px] border-[1.5px] p-4"
        style={{ background: styles.card, borderColor: styles.border }}
        aria-label="Sub-agent model (temporary)"
      >
        <p className="text-[11px]" style={{ color: "#ef4444" }} role="alert">
          Agent core unreachable — start the app (or pnpm dev:full) to pick a sub-agent model.
        </p>
      </section>
    );
  }

  const selected = settingsQuery.data.subagentModel;
  const selectedEntry = SUBAGENT_MODEL_CATALOG.find((m) => m.id === selected);

  const toPickerRows = () =>
    SUBAGENT_MODEL_CATALOG.map((m) => ({
      ...m,
      modelId: m.id,
      inputPricePerMtok: m.free ? 0 : null,
    }));

  const rows = filterModelsForPicker(toPickerRows(), modelsFreeOnly);
  const freeCount = filterModelsForPicker(toPickerRows(), true).length;

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
            {selectedEntry?.name ?? selected}
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
            { id: "all", label: `All models (${SUBAGENT_MODEL_CATALOG.length})`, active: !modelsFreeOnly, pick: () => setModelsFreeOnly(false) },
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
            const disabled = !m.tools;
            const isSelected = selected === m.id;
            const recommended = m.id === SUBAGENT_RECOMMENDED_ID;
            return (
              <button
                key={m.id}
                onClick={() => !disabled && saveModel.mutate(m.id)}
                disabled={disabled}
                aria-label={disabled ? `${m.id} (unavailable)` : `Use ${m.id} for sub-agents`}
                title={disabled ? "tool calling required" : m.id}
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
                    {m.name}
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
                  {m.id}
                </span>
                <span className="text-[10px] shrink-0 tabular-nums" style={{ color: styles.textTertiary }}>
                  {formatCtx(m.ctx)}
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

/* ── Composition ──────────────────────────────────────────────────────────── */

/** The two cards (reused by the Advanced tab until the sidebar gains a
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
