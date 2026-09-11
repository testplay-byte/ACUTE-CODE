import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Copy,
  Eye,
  EyeOff,
  Globe,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
// ROUND-87 (R87): the shared ease curve for the dialog/entrance animations.
import { ease } from "../../lib/motion";
import { useTimeoutClear } from "../../hooks/use-timeout-clear";
import { useAgents } from "../../hooks/use-agents";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { withAlpha } from "../dashboard/helpers";
import { isFreeModelEntry, useSettingsStore } from "../../lib/settings-store";
import { isTauri } from "../../lib/sidecar";
import { nextFreeSlot, revealProviderKeys } from "../../lib/key-pool";
import { useScrollFade } from "../../lib/useScrollFade";
import {
  createProvider,
  deleteProvider,
  deleteProviderModelConfig,
  fetchKeyPool,
  fetchModelsCatalog,
  fetchProviderModelConfig,
  fetchProviderModelEntries,
  fetchProviders,
  removeKeyPoolSlot,
  setKeyPoolSlot,
  storeProviderKey,
  testModelConnection,
  testProviderConnection,
  updateProvider,
  updateProviderModelConfig,
  upsertProviderModelConfig,
  type CatalogModel,
  type ProviderModelCatalogEntry,
  type ProviderModelConfig,
  type ProviderModelConfigPatch,
  type ProviderPatch,
  type ProviderTestResult,
  type ProviderView,
} from "../../lib/api";

/**
 * ModelsProvidersTab — ROUND-37 REBUILD (owner directive):
 *
 * > "there is no need to show the providers at all. There will be only
 * > providers, all of them all together… When the user clicks 'Add Provider',
 * > the user will be prompted which provider he is wanting to add: is he
 * > going to add a custom provider or is he going to add others from the
 * > list… He will be given these options to delete it, to change the base
 * > URL, to change the name… and the API key. He can also select the API
 * > format… Anthropic messages / Chat completion / Responses."
 *
 * ROUND-50 (R50-d) — the owner's models/providers feedback:
 *
 * > "The left sidebar is the one which shows me the providers… and on the
 * > right side it shows me the details of the providers. Both of them should
 * > be independent… They will scroll independently from each other. The UI
 * > of the right side needs to be improved… There is no option to set up
 * > some advanced details about the models and providers. Configuring the
 * > models is not that proper. I cannot select the models there, like which
 * > models I want to add, and I can also not configure the details of the
 * > models properly, like their input price, output price, cache hit rate
 * > price, and various other things like those."
 *
 * So this round: the tab is a viewport-locked master–detail (the left
 * provider list and the right detail pane each scroll INDEPENDENTLY — no
 * shared page scroll), the detail pane is re-sectioned into labeled cards
 * (Header / Connection / API Key Pool / Models / Danger zone), "Add models"
 * opens a catalog-driven multi-select picker (with a manual-id fallback for
 * custom providers), and every model row gets a full configuration dialog
 * (pricing per Mtok in/out/cache, context window, max output, thinking,
 * hidden).
 *
 * ROUND-59 (R59-C) — the owner's four settings directives: unconfigured
 * preset providers are hidden ENTIRELY (the R58 "Not configured" collapsed
 * group is gone — Add Provider's preset picker is the one way to set one
 * up), the API-key field presents the STORED key masked with ONE clear
 * Show, disabling a provider is OUTRIGHT (no agent-impact confirm), and
 * opening the page pre-selects the FIRST provider.
 *
 * ROUND-60 (R60-B) — the settings deep-clean: the API-key field is ONE
 * unified layout — [value input][eye toggle in the exact same slot in every
 * state][context action] — with NO rotate flow (the owner pastes the new
 * key straight into the field); the models list shows CONFIGURED rows ONLY
 * (the live catalog lives in the "Add models" picker, which now owns the
 * Free only ↔ All models toggle on the shared persisted modelsFreeOnly
 * pref); every stored row — free ones included — stays fully customizable
 * via the pencil dialog (the FREE badge rides isFreeModelEntry).
 *
 * ROUND-62 (R62-2b, owner: "the models and providers page is not proper and
 * the changes applied there don't reflect properly on the agent session
 * page as they should and also I am unable to configure the per million
 * input and output token price for the models properly"): every mutation
 * here now fans its invalidation out to the SESSION PAGE's model-picker
 * query-key families (the two pages read the same resources through
 * different cache keys with up to 5-minute staleTimes — the staleness root
 * cause); the pricing dialog labels the fields explicitly in $ PER 1M
 * TOKENS with decimal inputMode and gained the missing supportsVision
 * toggle (the last uneditable row field); failed loads surface honest
 * error states instead of silently rendering as empty lists.
 */

/* ── API plumbing ───────────────────────────────────────────────────────────
 * ROUND-47 (R47-c1): the local useApi() wrapper is GONE — this component used
 * to carry its own third HTTP plumbing layer beside src/lib/api.ts and
 * onboarding/providers-api.ts. Every provider CRUD / key / connection-test /
 * models-config call now goes through the canonical src/lib/api.ts fns
 * (typed envelopes + ApiError — see the ROUND-47 section there). */

/** ROUND-47 (R47-c1): browser-dev honesty — the sidecar's keyring is
 * in-memory, so keys stored through the browser dev UI do not survive a
 * restart (the desktop app's OS secure store is the durable path). */
const EPHEMERAL_KEY_NOTE =
  "Browser-dev keys live in server memory only — they reset on restart; use the desktop app (its OS secure store is the durable path).";

/* ── ROUND-62 (R62-2b): cross-page cache invalidation ─────────────────────────
 * The agent session page's model picker (composer/ModelSelector.tsx) reads
 * the SAME providers + models-config resources through its OWN query-key
 * families — ["composer-providers"], ["provider-models", id] and
 * ["provider-models-config", id] — with staleTimes of 60s / 5min / 5min.
 * This tab used to invalidate ONLY its own ["settings-*"] keys, so a
 * rename/hide/add/delete made here kept rendering the OLD state on the
 * session page for up to five minutes (one QueryClient is shared app-wide
 * by main.tsx, so the invalidation crosses the route change — it marks the
 * picker's entries stale and the next popover open refetches). */

/** Provider-level mutations (create/rename/toggle/delete/base-url/key): fan
 * the invalidation out to every page that lists providers. The live-catalog
 * family rides along because its content depends on the provider row
 * (baseUrl), and the prefix form hits every provider's entry. */
export function invalidateProvidersEverywhere(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ["settings-providers"] });
  void queryClient.invalidateQueries({ queryKey: ["composer-providers"] });
  void queryClient.invalidateQueries({ queryKey: ["provider-models"] });
}

/** Model-config mutations (add/configure/delete): fan the invalidation out
 * to the session picker's models-config family (display names, hidden
 * flags, per-1M-token pricing all live there). */
export function invalidateModelConfigEverywhere(
  queryClient: QueryClient,
  providerId: string,
): void {
  void queryClient.invalidateQueries({ queryKey: ["settings-provider-models", providerId] });
  void queryClient.invalidateQueries({ queryKey: ["provider-models-config"] });
}

/** The three wire formats the runtime speaks (ROUND-37). */
const API_FORMATS: Array<{ id: string; label: string; hint: string }> = [
  { id: "chat-completions", label: "Chat completions", hint: "OpenAI-compatible /v1/chat/completions — works with OpenRouter, vLLM, Ollama, gateways" },
  { id: "anthropic-messages", label: "Anthropic messages", hint: "/v1/messages — Anthropic and Anthropic-compatible endpoints" },
  { id: "responses", label: "Responses", hint: "OpenAI /v1/responses — the Responses API" },
];

/** Presets offered by the Add Provider dialog (owner: "is he going to add a
 * custom provider or is he going to add others from the list"). */
const PRESETS: Array<{
  id: string;
  name: string;
  baseUrl: string;
  apiFormat: string;
  blurb: string;
}> = [
  {
    id: "custom",
    name: "Custom provider",
    baseUrl: "",
    apiFormat: "chat-completions",
    blurb: "Any endpoint — fill in the details yourself.",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiFormat: "chat-completions",
    blurb: "One key, hundreds of models.",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    apiFormat: "anthropic-messages",
    blurb: "Claude models via the Messages API.",
  },
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiFormat: "chat-completions",
    blurb: "GPT models (chat completions).",
  },
  {
    id: "google",
    name: "Google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiFormat: "chat-completions",
    blurb: "Gemini models via the OpenAI-compatible surface.",
  },
  {
    // ROUND-80 (R80, owner: "make sure it works with the nvidia api key
    // too"): NVIDIA NIM (build.nvidia.com) — OpenAI-compatible chat
    // completions at integrate.api.nvidia.com with nvapi-… keys. The row
    // is a seeded built-in (agent-core storage/providers.ts); this preset
    // routes the Add-Provider dialog's key storage to the same id.
    id: "nvidia",
    name: "NVIDIA",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    apiFormat: "chat-completions",
    blurb: "NIM models (Llama, Nemotron, DeepSeek…) via build.nvidia.com.",
  },
];

const formatLabel = (id: string | undefined): string =>
  API_FORMATS.find((f) => f.id === id)?.label ?? "Chat completions";

/* ── ROUND-58 (R58-d): preset-provider scoping ──────────────────────────────
 * Mirrors agent-core's RESERVED_PROVIDER_IDS (storage/providers.ts) — the
 * seeded built-in adapters whose endpoint + wire format are FIXED. Client-side
 * copy because the providers list wire format carries no "reserved" flag; the
 * two constants move together (same review checklist as PRESETS above). */
const PRESET_PROVIDER_IDS: ReadonlySet<string> = new Set([
  "anthropic",
  "openai",
  "google",
  "openrouter",
  "nvidia",
]);

/* ── ROUND-50 (R50-d) shared micro-formatting ─────────────────────────────── */

/** 256000 → "256k ctx", 1048576 → "1.048M ctx" (mono micro-badges). */
function formatContextWindow(tokens: number | null): string | null {
  if (tokens === null) return null;
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(2))}M ctx`;
  return `${Math.round(tokens / 1000)}k ctx`;
}

/** Compact per-Mtok pricing summary, e.g. "$0.15 in / $0.60 out / $0.02 cache".
 * Parts that are unknown (null) are simply omitted — never rendered as $0. */
function formatPricingSummary(model: {
  inputPricePerMtok: number | null;
  outputPricePerMtok: number | null;
  inputPriceCachedPerMtok: number | null;
}): string | null {
  const parts: string[] = [];
  if (model.inputPricePerMtok !== null) parts.push(`$${model.inputPricePerMtok} in`);
  if (model.outputPricePerMtok !== null) parts.push(`$${model.outputPricePerMtok} out`);
  if (model.inputPriceCachedPerMtok !== null) parts.push(`$${model.inputPriceCachedPerMtok} cache`);
  return parts.length > 0 ? parts.join(" / ") : null;
}

/** Parses a numeric dialog field: "" → null (unknown/inherit), otherwise a
 * finite number ≥ 0. Returns "invalid" for junk the user must fix. */
function parseNumericField(raw: string): number | null | "invalid" {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return "invalid";
  return value;
}

/** ROUND-87 (R87): the model card's capability chips — the honest, user-set
 * INPUT/OUTPUT flags. Inputs: images (vision), videos, PDFs, audio. Outputs:
 * text, images, video, audio. Reasoning + tool use are deliberately NOT
 * here (the app detects those at runtime — the owner's directive). */
function capabilityChips(
  model: ProviderModelConfig | undefined,
): Array<{ label: string; color: string; title: string }> {
  if (model === undefined) return [];
  const chips: Array<{ label: string; color: string; title: string }> = [];
  if (model.supportsVision) chips.push({ label: "IMG IN", color: "#8b5cf6", title: "Accepts image inputs" });
  if (model.supportsVideo === true) chips.push({ label: "VID IN", color: "#8b5cf6", title: "Accepts video inputs" });
  if (model.supportsPdf === true) chips.push({ label: "PDF IN", color: "#8b5cf6", title: "Accepts PDF documents" });
  if (model.supportsAudio === true) chips.push({ label: "AUD IN", color: "#8b5cf6", title: "Accepts audio inputs" });
  if (model.supportsTextOutput === true) chips.push({ label: "TEXT OUT", color: "#0ea5e9", title: "Produces text output" });
  if (model.supportsImageOutput === true) chips.push({ label: "IMG OUT", color: "#0ea5e9", title: "Produces image output" });
  if (model.supportsVideoOutput === true) chips.push({ label: "VID OUT", color: "#0ea5e9", title: "Produces video output" });
  if (model.supportsAudioOutput === true) chips.push({ label: "AUD OUT", color: "#0ea5e9", title: "Produces audio output" });
  return chips;
}

/** The section micro-label the rest of the app uses (uppercase, tracked). */
function SectionLabel({
  children,
  color,
}: {
  children: string;
  color?: string;
}) {
  const styles = useThemeStyles();
  return (
    <span
      className="text-[10px] font-bold uppercase tracking-widest"
      style={{ color: color ?? styles.textTertiary }}
    >
      {children}
    </span>
  );
}

/* ── Component ────────────────────────────────────────────────────────────── */

export function ModelsProvidersTab() {
  const styles = useThemeStyles();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  // ROUND-50 (R50-d): the provider-list scroll column — one of the two
  // INDEPENDENT scroll containers (the right detail pane is the other).
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  useScrollFade(listScrollRef);

  const providersQuery = useQuery({
    queryKey: ["settings-providers"],
    queryFn: () => fetchProviders(),
  });
  // ROUND-37: ONE flat list — every provider together, order = created.
  const providers = providersQuery.data ?? [];

  // ROUND-59 (R59-C): the list shows CONFIGURED providers only — a provider
  // is "configured" when it holds a key OR was created by the user (custom
  // rows are always real choices). The R58 collapsed "Not configured"
  // group is GONE: the owner deleted the three seeded presets by hand and
  // wants them never to appear by default; the Add Provider dialog's
  // preset picker remains the one sanctioned way to (re)set one up.
  const configuredProviders = providers.filter(
    (p) => p.hasKey || !PRESET_PROVIDER_IDS.has(p.id),
  );

  // ROUND-62 (R62-2b): the fan-out helper above — provider mutations reach
  // the session page's picker cache too (the old settings-only
  // invalidation is why toggles/renames never showed up there).
  const invalidate = () => invalidateProvidersEverywhere(queryClient);

  const selected = useMemo(
    () => providers.find((p) => p.id === selectedId) ?? null,
    [providers, selectedId],
  );

  // ROUND-59 (R59-C): pre-select the FIRST provider on open (the owner:
  // "by default when the user opens the providers page, it will pre-select
  // the top provider and open its details on the right") — and keep the
  // selection honest when the underlying list changes: a selected row that
  // is no longer VISIBLE (deleted, or its key was removed from a preset so
  // it left the configured list) is cleared and falls to the first
  // remaining row instead of lingering in the detail pane.
  // Deliberately keyed on `providers` (the query data identity — it only
  // moves when the query resolves or refetches with changed content): an
  // explicit user click is never re-processed, and the null selection the
  // "Add provider" flow may set is not instantly overridden.
  useEffect(() => {
    const hidden =
      selectedId !== null && !configuredProviders.some((p) => p.id === selectedId);
    if (hidden) setSelectedId(null);
    if ((selectedId === null || hidden) && configuredProviders.length > 0) {
      setSelectedId(configuredProviders[0].id);
    }
  }, [providers]);

  return (
    // ROUND-50 (R50-d): viewport-locked master–detail — the tab fills the
    // settings content area (no shared page scroll); the LEFT provider list
    // and the RIGHT detail pane each scroll independently.
    <div className="flex h-full min-h-0 gap-4">
      {/* ROUND-62 (R62-2b): honest load/error states — a failed GET /providers
          used to render identically to "you have no providers" (an empty
          list + the placeholder card), which is exactly a page that looks
          "not proper". The error now surfaces as a red alert with the
          server's message; a fetch in flight shows the loading row instead
          of a misleading "No providers". */}
      {/* ── LEFT: the provider list (ROUND-58 R58-d: content-adaptive height —
          shrinks with few providers, keeps a 220px floor, still scrolls when
          many — the owner: "It should adapt its height according to the content
          inside it… There should be a minimum height"). ─────────────────── */}
      <div
        className="w-[280px] shrink-0 h-fit max-h-full min-h-[220px] rounded-[16px] border-[1.5px] overflow-hidden flex flex-col"
        style={{ background: styles.card, borderColor: styles.border }}
      >
        <div
          className="shrink-0 flex items-center gap-2 px-3.5 py-3 border-b"
          style={{ borderColor: styles.border }}
        >
          <SectionLabel>Providers</SectionLabel>
          {/* ROUND-59 (R59-C): the count reflects what the list SHOWS —
              configured rows only (unconfigured presets are absent). */}
          <span
            data-testid="provider-count"
            className="font-mono text-[10px]"
            style={{ color: styles.textTertiary }}
          >
            {configuredProviders.length}
          </span>
        </div>
        {providersQuery.isError && (
          <div
            role="alert"
            className="px-3.5 py-2 border-b text-[11px]"
            style={{ borderColor: styles.border, color: "#ef4444" }}
          >
            Couldn&apos;t load providers —{" "}
            {providersQuery.error instanceof Error ? providersQuery.error.message : String(providersQuery.error)}
          </div>
        )}
        <div
          ref={listScrollRef}
          className="flex-1 min-h-0 overflow-y-auto auto-scroll p-1.5"
        >
          {providersQuery.isLoading && (
            <div className="px-2.5 py-1.5 text-[11px]" style={{ color: styles.textTertiary }}>
              loading providers…
            </div>
          )}
          {/* ROUND-59 (R59-C): empty means NO CONFIGURED rows — keyless
              presets don't count as providers here anymore. */}
          {!providersQuery.isLoading && configuredProviders.length === 0 && (
            <div className="px-2.5 py-1.5 text-[11px]" style={{ color: styles.textTertiary }}>
              No providers — add one below.
            </div>
          )}
          {configuredProviders.map((p) => (
            <ProviderListRow
              key={p.id}
              provider={p}
              active={p.id === selectedId}
              onClick={() => setSelectedId(p.id)}
            />
          ))}
        </div>
        {/* + Add provider → the preset-or-custom DIALOG (owner R37) */}
        <div className="shrink-0 p-1.5 border-t" style={{ borderColor: styles.border }}>
          <button
            onClick={() => {
              // ROUND-59 (R59-C): no longer deselects — pre-select keeps the
              // detail pane meaningful behind the modal, and Cancel restores
              // the user's context instead of a blank placeholder.
              setAdding(true);
            }}
            className="w-full h-9 flex items-center justify-center gap-1.5 rounded-[10px] text-[12px] font-bold transition-colors"
            style={{ background: withAlpha(styles.accent, 0.1), color: styles.accent }}
            onMouseEnter={(e) => (e.currentTarget.style.background = withAlpha(styles.accent, 0.18))}
            onMouseLeave={(e) => (e.currentTarget.style.background = withAlpha(styles.accent, 0.1))}
          >
            <Plus size={13} strokeWidth={2.5} /> Add provider
          </button>
        </div>
      </div>

      {/* ── RIGHT: the detail panel — its OWN scroll container (R50-d) ──── */}
      <div className="flex-1 min-w-0 min-h-0 flex flex-col">
        {selected ? (
          <DetailScrollArea key={selected.id}>
            <ProviderDetailPane
              provider={selected}
              onChanged={invalidate}
              onDeleted={() => {
                // ROUND-59 (R59-C): deleting the SELECTED provider falls to
                // the next remaining row (the owner never wanted the empty
                // state after a delete) — the row after the deleted one, else
                // the first remaining, else nothing when the list is empty.
                const idx = configuredProviders.findIndex((p) => p.id === selected.id);
                const remaining = configuredProviders.filter((p) => p.id !== selected.id);
                const next = remaining[Math.min(idx, remaining.length - 1)] ?? null;
                setSelectedId(next?.id ?? null);
                invalidate();
              }}
            />
          </DetailScrollArea>
        ) : (
          <div className="flex-1 min-h-0 grid place-items-center rounded-[16px] border-[1.5px] border-dashed" style={{ borderColor: styles.border }}>
            <div className="text-center px-6">
              <div
                className="w-12 h-12 mx-auto rounded-[14px] grid place-items-center"
                style={{ background: withAlpha(styles.accent, 0.1), color: styles.accent }}
                aria-hidden
              >
                <Globe size={22} />
              </div>
              <p className="mt-3 text-[14px] font-bold" style={{ color: styles.text }}>
                Select a provider
              </p>
              <p className="mt-1 text-[12px]" style={{ color: styles.textSecondary }}>
                Pick one from the list to configure its key, endpoint, and models — or add a provider.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Add Provider DIALOG (preset choice → fields)
          R89-B1: the owner's identity rules — the NAME is the uniqueness
          key (live feedback from the configured names), presets stay
          addable forever (a "configured" chip, never a disable — as many
          same-type providers as needed under distinct names), and a preset
          pick ADOPTS its keyless seeded row server-side (the "NVIDIA
          already exists" bug on a fresh reset: the boot seed's keyless
          rows are invisible in this list but USED to 409 the create). */}
      {adding && (
        <AddProviderDialog
          existingNames={new Set(configuredProviders.map((p) => p.name))}
          configuredPresetIds={new Set(configuredProviders.map((p) => p.id))}
          onClose={() => setAdding(false)}
          onCreated={(id) => {
            setAdding(false);
            setSelectedId(id);
            invalidate();
          }}
        />
      )}
    </div>
  );
}

/** ROUND-50 (R50-d): the RIGHT column's independent scroll container — the
 * detail pane's cards grow naturally and this area (and ONLY this area)
 * scrolls; the provider list on the left stays put. Same .auto-scroll +
 * useScrollFade treatment as every other long panel in the app. */
function DetailScrollArea({ children }: { children: React.ReactNode }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useScrollFade(scrollRef);
  return (
    <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto auto-scroll pr-1">
      {children}
    </div>
  );
}

/* ── Left list row (flat — one line per provider) ─────────────────────────── */

function ProviderListRow({
  provider,
  active,
  onClick,
}: {
  provider: ProviderView;
  active: boolean;
  onClick: () => void;
}) {
  const styles = useThemeStyles();
  return (
    <button
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      className="relative w-full h-11 flex items-center gap-2.5 px-2.5 rounded-[10px] transition-colors text-left"
      style={{ background: active ? withAlpha(styles.accent, 0.1) : "transparent" }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = styles.subtleHover;
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = "transparent";
      }}
    >
      {active && (
        <span
          className="absolute left-0 top-1.5 bottom-1.5 w-[2.5px] rounded-full"
          style={{ background: styles.accent }}
          aria-hidden
        />
      )}
      <span
        className="w-7 h-7 shrink-0 rounded-[8px] grid place-items-center"
        style={{ background: styles.inputBg, color: styles.textSecondary }}
      >
        <Globe size={13} />
      </span>
      <span className="min-w-0 flex-1 flex flex-col items-start">
        <span
          className="w-full truncate text-[12.5px] font-semibold"
          style={{ color: active ? styles.text : styles.textSecondary }}
        >
          {provider.name}
        </span>
        <span
          className="w-full truncate font-mono text-[9.5px]"
          style={{ color: styles.textTertiary }}
          // ROUND-44 (VLM pass): the row clips the endpoint + wire format to one
          // line — surface the full text on hover so it stays verifiable.
          title={`${provider.baseUrl ?? "no url"} · ${formatLabel(provider.apiFormat)}`}
        >
          {provider.baseUrl ? new URL(provider.baseUrl).host : "no url"} · {formatLabel(provider.apiFormat)}
        </span>
      </span>
      {/* Status dot: green = key stored; grey = no key. */}
      <span
        className="w-2 h-2 shrink-0 rounded-full"
        style={{
          background: provider.hasKey ? "#22c55e" : withAlpha(styles.text, 0.25),
        }}
        title={provider.hasKey ? "Key stored" : "No key set"}
      />
    </button>
  );
}

/* ── Right detail pane (ROUND-37: EVERY provider fully editable) ────────────
 * ROUND-50 (R50-d): re-sectioned into clearly-labeled cards — Header →
 * Connection → API Key Pool → Models → Danger zone — with one consistent
 * spacing rhythm (p-4/p-5 cards, gap-5 between them, uppercase micro-labels
 * matching the rest of the app). */

function ProviderDetailPane({
  provider,
  onChanged,
  onDeleted,
}: {
  provider: ProviderView;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const styles = useThemeStyles();
  const queryClient = useQueryClient();
  // ROUND-57: every transient-message reset in this pane rides the leak-safe
  // scheduler — the bare setTimeout variant outlived unmount/teardown and
  // failed CI with "window is not defined" (run 33411797885).
  const resetAfter = useTimeoutClear();

  const [keyStatus, setKeyStatus] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(provider.name);
  const [baseUrlDraft, setBaseUrlDraft] = useState(provider.baseUrl ?? "");
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // ROUND-60 (R60-B): the paste-to-replace draft — null means "not editing"
  // (the field displays the STORED key, masked or revealed read-only);
  // any non-null string is the user's typed/pasted NEW key awaiting Save.
  // The R59 rotate button + rotatingKey flag are gone: the owner pastes the
  // new key straight into the field ("There is actually no need to give the
  // rotate key option at all… The user can directly paste in the new key").
  const [keyDraft, setKeyDraft] = useState<string | null>(null);
  // ROUND-58 (R58-d): the primary-key reveal state — NEVER auto-fetched;
  // fetched only on the explicit "Show" click, then rendered read-only
  // with Copy + Hide (masks again).
  const [revealState, setRevealState] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "shown"; value: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  // ROUND-59 (R59-C): copy confirmations/errors color themselves (a copy
  // failure must not inherit the save-mutation's green styling).
  const [keyStatusIsError, setKeyStatusIsError] = useState(false);
  // ROUND-47 (R47-c1): the test surface got explicit selectors — WHICH key
  // (primary or a held pool slot) and WHICH model (or reachability-only) —
  // instead of an invisible "primary key, no model" default.
  const [testKeyChoice, setTestKeyChoice] = useState<"primary" | number>("primary");
  const [testModel, setTestModel] = useState<string>(""); // "" = reachability only
  const [testState, setTestState] = useState<
    | { kind: "idle" }
    | { kind: "testing" }
    | { kind: "ok"; ms: number; model?: string; note?: string }
    | { kind: "fail"; message: string }
  >({ kind: "idle" });

  const modelsQuery = useQuery({
    queryKey: ["settings-provider-models", provider.id],
    queryFn: () => fetchProviderModelConfig(provider.id),
  });
  const models = modelsQuery.data ?? [];

  // ROUND-58 (R58-d): the agent registry — powers the disable warning ("N
  // agent(s) use this provider"). Uses the standard agents hook (fixture
  // adapter in demo mode, HTTP otherwise); never blocks the pane.
  const agentsQuery = useAgents(false);
  const agentsUsingProvider = (agentsQuery.data ?? []).filter(
    (a) => a.providerId === provider.id,
  );
  // ROUND-58 (R58-d): preset providers (the seeded built-ins) — endpoint and
  // wire format are FIXED, so the Base URL input + API-format grid are hidden
  // (the owner: "there is actually no need to show the API format options or
  // the base URL either… It should only be shown for custom providers").
  const isPreset = PRESET_PROVIDER_IDS.has(provider.id);

  // ROUND-47 (R47-c1): the key-pool listing feeds the test key selector.
  // SAME query key as KeyPoolSection's — one shared cache entry per provider.
  const poolQuery = useQuery({
    queryKey: ["key-pool", provider.id],
    queryFn: () => fetchKeyPool(provider.id),
  });
  const heldPoolSlots = (poolQuery.data ?? [])
    .filter((k) => k.slot > 0 && k.hasKey)
    .map((k) => k.slot);
  // ROUND-59 (R59-C): the masked slot-0 (primary) value — from the SAME
  // key-pool listing the test-key selector already rides (no extra fetch);
  // dots while it loads or if the listing omits slot 0.
  const maskedStoredKey =
    poolQuery.data?.find((k) => k.slot === 0 && k.hasKey)?.masked ?? "•••••••••••";

  // ROUND-50 (R50-d): the provider's LIVE catalog WITH names — feeds the test
  // model selector AND the "Add models" picker (ids alone can't power a
  // searchable multi-select). Fails soft — offline or custom providers fall
  // back to the configured rows + the manual add-by-id path.
  const catalogQuery = useQuery({
    queryKey: ["settings-provider-models-catalog", provider.id],
    queryFn: () => fetchProviderModelEntries(provider.id),
    retry: false,
  });
  const catalogEntries = catalogQuery.data ?? [];
  const catalogIds = catalogEntries.map((entry) => entry.id);

  // ROUND-50 (R50-d): the served static catalog (GET /models/catalog) — the
  // free/paid + pricing metadata the picker pre-fills from. Same query key
  // as SubAgentsTab/AgentFormDialog (one shared cache entry); fails soft.
  const staticCatalogQuery = useQuery({
    queryKey: ["models-catalog"],
    queryFn: fetchModelsCatalog,
    retry: false,
  });
  const staticCatalog = staticCatalogQuery.data?.models ?? [];

  const saveKey = useMutation({
    mutationFn: async (value: string) => {
      // Tauri: keys route through the shell into the OS secure store
      // (ADR-0012). Browser dev: the sidecar keyring endpoint.
      if (isTauri()) {
        const { storeProviderKey: storeViaShell } = await import("../onboarding/providers-api");
        const ok = await storeViaShell(provider.id, value);
        if (!ok) throw new Error("the shell refused the key store request");
        return;
      }
      await storeProviderKey(provider.id, value);
    },
    onSuccess: () => {
      // ROUND-60 (R60-B): a saved key exits edit mode (the masked
      // stored-key view returns — a stale revealed OLD value is dropped
      // too) and refreshes the pool listing so the masked slot-0 value is
      // the NEW key's, never the stale one.
      setKeyDraft(null);
      setRevealState({ kind: "idle" });
      setKeyStatus("Key saved to the secure store.");
      // ROUND-62 (R62-2b): hasKey flips — the picker's provider cache sees
      // it (the session page doesn't list keyless presets differently, but
      // one cache, one truth).
      invalidateProvidersEverywhere(queryClient);
      void queryClient.invalidateQueries({ queryKey: ["key-pool", provider.id] });
    },
    onError: (err: Error) => setKeyStatus(err.message),
  });

  const saveDetails = useMutation({
    mutationFn: (patch: ProviderPatch) => updateProvider(provider.id, patch),
    onSuccess: () => {
      setSaveMsg("Saved.");
      resetAfter(() => setSaveMsg(null), 2000);
      onChanged();
    },
    onError: (err: Error) => setSaveMsg(err.message),
  });

  const removeProvider = useMutation({
    mutationFn: () => deleteProvider(provider.id),
    onSuccess: () => {
      // ROUND-62 (R62-2b): the provider is GONE — its models-config rows went
      // with it (ON DELETE CASCADE), so the session picker's config family
      // is invalidated too (the settings-side prefix invalidation stays).
      void queryClient.invalidateQueries({ queryKey: ["settings-provider-models"] });
      void queryClient.invalidateQueries({ queryKey: ["provider-models-config"] });
      onDeleted();
    },
    onError: (err: Error) => setSaveMsg(err.message),
  });

  const runTest = async () => {
    setTestState({ kind: "testing" });
    try {
      // ROUND-47 (R47-c1): key + model scope travel to the backend (R47-b
      // contract); latency is the SERVER-measured probe time, and an
      // ok:false answer arrives at HTTP 200 — shown honestly, never thrown.
      const result: ProviderTestResult = await testProviderConnection(provider.id, {
        ...(testKeyChoice !== "primary" ? { slot: testKeyChoice } : {}),
        ...(testModel !== "" ? { model: testModel } : {}),
      });
      if (result.ok) {
        setTestState({
          kind: "ok",
          ms: result.latencyMs ?? 0,
          model: result.model,
          note: result.message,
        });
      } else {
        setTestState({ kind: "fail", message: result.message ?? "provider rejected the probe" });
      }
    } catch (err) {
      setTestState({ kind: "fail", message: err instanceof Error ? err.message : String(err) });
    }
  };

  // ROUND-58 (R58-d) / R59-C: fetch + display the ACTUAL stored primary key
  // (the owner's reveal demand — "when I tap on the show button then it
  // will show up"). Only ever invoked from the explicit Show click — never
  // on mount. A missing slot-0 answer is surfaced honestly.
  const revealStoredKey = async () => {
    setRevealState({ kind: "loading" });
    try {
      const keys = await revealProviderKeys(provider.id);
      const primary = keys.find((k) => k.slot === 0);
      if (primary === undefined) {
        setRevealState({ kind: "error", message: "No key stored for this provider." });
        return;
      }
      setRevealState({ kind: "shown", value: primary.value });
    } catch (err) {
      setRevealState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };

  // ROUND-58 (R58-d): clipboard helper for revealed keys — the transient
  // confirmation rides the leak-safe scheduler (no bare setTimeout).
  const copyToClipboard = async (value: string, confirmation: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setKeyStatusIsError(false);
      setKeyStatus(confirmation);
      resetAfter(() => setKeyStatus(null), 1500);
    } catch {
      setKeyStatusIsError(true);
      setKeyStatus("Copy failed — the clipboard is unavailable in this context.");
      resetAfter(() => setKeyStatus(null), 1500);
    }
  };

  const inputStyle = {
    background: styles.bg,
    borderColor: styles.border,
    color: styles.text,
  } as const;

  // ROUND-60 (R60-B): the two display values the unified key field rides —
  // storedDisplay is what the input shows while NOT editing (the masked
  // slot-0 value, or the revealed full key); revealedValue is non-null only
  // while revealed (captured per render, so the fading-out Copy button can
  // never copy a stale value).
  const storedDisplay = revealState.kind === "shown" ? revealState.value : maskedStoredKey;
  const revealedValue = revealState.kind === "shown" ? revealState.value : null;

  return (
    <div className="flex flex-col gap-5">
      {/* ── Header: provider identity + status ─────────────────────────── */}
      <div
        className="rounded-[16px] border-[1.5px] p-4 flex items-center gap-3 flex-wrap"
        style={{ background: styles.card, borderColor: styles.border }}
      >
        <span
          className="w-10 h-10 shrink-0 rounded-[12px] grid place-items-center"
          style={{ background: withAlpha(styles.accent, 0.1), color: styles.accent }}
          aria-hidden
        >
          <Globe size={17} />
        </span>
        <div className="min-w-0 flex-1">
          {editingName ? (
            <input
              autoFocus
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  setEditingName(false);
                  if (nameDraft.trim() && nameDraft.trim() !== provider.name) {
                    saveDetails.mutate({ name: nameDraft.trim() });
                  }
                }
                if (e.key === "Escape") {
                  setNameDraft(provider.name);
                  setEditingName(false);
                }
              }}
              onBlur={() => {
                setEditingName(false);
                if (nameDraft.trim() && nameDraft.trim() !== provider.name) {
                  saveDetails.mutate({ name: nameDraft.trim() });
                }
              }}
              aria-label="Provider name"
              className="h-9 w-full max-w-[320px] rounded-[10px] border-[1.5px] px-3 text-[14px] font-bold outline-none"
              style={inputStyle}
            />
          ) : (
            <button
              onClick={() => setEditingName(true)}
              className="flex items-center gap-2 min-w-0"
              title="Click to rename"
            >
              <span className="text-[16px] font-black truncate" style={{ color: styles.text }}>
                {provider.name}
              </span>
              <Pencil size={12} style={{ color: styles.textTertiary }} />
            </button>
          )}
          <span
            className="block truncate font-mono text-[10px]"
            style={{ color: styles.textTertiary }}
            title={`${provider.baseUrl ?? "no url"} · ${formatLabel(provider.apiFormat)}`}
          >
            {provider.baseUrl ?? "no url"} · {formatLabel(provider.apiFormat)}
          </span>
        </div>
        {/* Enabled badge + key badge + the enable/disable toggle (every
            provider — ROUND-58 R58-d: a proper SWITCH, not the old bare
            underlined text link; ROUND-59 R59-C: flipping it acts
            OUTRIGHT). */}
        <span
          className="px-2 py-0.5 rounded-full text-[10px] font-bold"
          style={{
            background: provider.enabled ? withAlpha("#22c55e", 0.12) : styles.subtle,
            color: provider.enabled ? "#22c55e" : styles.textTertiary,
          }}
        >
          {provider.enabled ? "● Enabled" : "○ Disabled"}
        </span>
        <span
          className="px-2 py-0.5 rounded-full text-[10px] font-bold"
          style={{
            background: provider.hasKey ? withAlpha("#22c55e", 0.12) : styles.subtle,
            color: provider.hasKey ? "#22c55e" : styles.textTertiary,
          }}
        >
          {provider.hasKey ? "● Key stored" : "○ No key"}
        </span>
        {/* ROUND-59 (R59-C): the enable/disable toggle acts OUTRIGHT — the
            owner: no "One agent uses this provider" confirm; a disabled
            provider's models simply disappear from the pickers. The agent
            count survives ONLY as this quiet hover tooltip. */}
        <span className="flex items-center gap-1.5">
          <span className="text-[11px] font-bold" style={{ color: styles.textSecondary }}>
            {provider.enabled ? "Enabled" : "Disabled"}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={provider.enabled}
            aria-label={`Toggle provider ${provider.name}`}
            title={
              provider.enabled
                ? agentsUsingProvider.length > 0
                  ? `${agentsUsingProvider.length} agent(s) use this provider — disabling takes effect immediately`
                  : "Disable this provider"
                : "Re-enable this provider"
            }
            disabled={saveDetails.isPending}
            onClick={() => {
              // R59-C: NO gate — the PATCH fires immediately.
              saveDetails.mutate({ enabled: !provider.enabled });
            }}
            className="relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors disabled:cursor-wait disabled:opacity-60"
            style={{
              background: provider.enabled ? styles.accent : withAlpha(styles.text, 0.18),
              border: `1.5px solid ${provider.enabled ? styles.accent : styles.border}`,
            }}
          >
            <span
              className="absolute top-1/2 block rounded-full bg-white shadow transition-all"
              style={{
                left: provider.enabled ? "calc(100% - 21px)" : "3px",
                height: 18,
                width: 18,
                transform: "translateY(-50%)",
              }}
            />
          </button>
        </span>
        {saveMsg && (
          <span className="text-[11px] font-bold" style={{ color: styles.accent }}>
            {saveMsg}
          </span>
        )}
      </div>

      {/* ── Connection: base URL / API format / key + test ─────────────── */}
      <div
        className="rounded-[16px] border-[1.5px] p-4 md:p-5 flex flex-col gap-4"
        style={{ background: styles.card, borderColor: styles.border }}
      >
        <SectionLabel>Connection</SectionLabel>
        {/* ROUND-58 (R58-d): PRESET providers (the seeded built-ins) hide the
            Base URL input + API-format grid — endpoint and format are fixed
            (the owner: "It should only be shown for custom providers"). The
            API-key input + Test connection below stay for EVERY provider. */}
        {isPreset ? (
          <p className="text-[10.5px]" style={{ color: styles.textTertiary }} data-preset-note>
            Preset provider — endpoint and format are fixed.
          </p>
        ) : (
          <>
            {/* Base URL (editable — custom providers; owner R37) */}
            <div>
              <label className="mb-1.5 block text-[11px] font-bold" style={{ color: styles.textSecondary }}>
                Base URL
              </label>
              <div className="flex gap-2">
                <input
                  value={baseUrlDraft}
                  onChange={(e) => setBaseUrlDraft(e.target.value)}
                  aria-label="Base URL"
                  className="h-10 flex-1 min-w-0 rounded-[10px] border-[1.5px] px-3 font-mono text-[12px] outline-none"
                  style={inputStyle}
                />
                {baseUrlDraft.trim() !== (provider.baseUrl ?? "") && (
                  <button
                    onClick={() => saveDetails.mutate({ baseUrl: baseUrlDraft.trim() })}
                    className="h-10 px-4 rounded-[10px] text-[12px] font-bold"
                    style={{ background: styles.accent, color: styles.accentText }}
                  >
                    Save
                  </button>
                )}
              </div>
            </div>
            {/* API format — ROUND-37: the REAL selector (3 formats) */}
            <div>
              <label className="mb-1.5 block text-[11px] font-bold" style={{ color: styles.textSecondary }}>
                API format
              </label>
              <div className="grid grid-cols-3 gap-2">
                {API_FORMATS.map((f) => {
                  const active = (provider.apiFormat ?? "chat-completions") === f.id;
                  return (
                    <button
                      key={f.id}
                      onClick={() => !active && saveDetails.mutate({ apiFormat: f.id })}
                      aria-pressed={active}
                      title={f.hint}
                      className="h-10 rounded-[10px] border-[1.5px] text-[12px] font-bold transition-colors"
                      style={{
                        borderColor: active ? withAlpha(styles.accent, 0.55) : styles.border,
                        background: active ? withAlpha(styles.accent, 0.09) : styles.bg,
                        color: active ? styles.accent : styles.textSecondary,
                      }}
                    >
                      {f.label}
                    </button>
                  );
                })}
              </div>
              <p className="mt-1.5 text-[10.5px]" style={{ color: styles.textTertiary }}>
                {API_FORMATS.find((f) => f.id === (provider.apiFormat ?? "chat-completions"))?.hint}
              </p>
            </div>
          </>
        )}
        {/* API key — ROUND-60 (R60-B): ONE unified layout that never
            reflows: [value input][eye toggle][context action]. The eye sits
            in the EXACT same slot in every state (Show while masked at
            rest, a spinner while loading, Hide while revealed — the owner:
            "the show and hide button should be in the exact same place").
            Rotation is GONE (the owner: "There is actually no need to give
            the rotate key option at all… The user can directly paste in the
            new key"): typing or pasting into the field swaps it to edit
            mode, the context slot shows Save key (+ Cancel X, Escape also
            restores), and Copy fades in with a width+opacity transition
            only while the stored key is revealed (the owner: "the copy
            button should appear smoothly and not in a bad way"). */}
        <div>
          <label className="mb-1.5 block text-[11px] font-bold" style={{ color: styles.textSecondary }}>
            API key {provider.hasKey && <span style={{ color: "#22c55e" }}>· stored</span>}
          </label>
          <div className="flex gap-2 items-stretch">
            <input
              // Cleartext on purpose — the ONE eye in this block belongs to
              // the STORED key; masking the user's own draft is what bred
              // the R58 two-eye ambiguity.
              type="text"
              value={provider.hasKey && keyDraft === null ? storedDisplay : keyDraft ?? ""}
              placeholder={provider.hasKey ? undefined : "sk-…"}
              aria-label={
                provider.hasKey && keyDraft === null
                  ? revealState.kind === "shown"
                    ? "Stored API key (revealed)"
                    : "Stored API key (masked)"
                  : "API key"
              }
              data-testid={
                provider.hasKey && keyDraft === null
                  ? revealState.kind === "shown"
                    ? "stored-key-revealed"
                    : "stored-key-masked"
                  : "new-key-input"
              }
              title={
                provider.hasKey
                  ? keyDraft === null
                    ? "The stored key — paste a new key to replace it"
                    : "The new key — Save key replaces the stored one"
                  : "Paste the provider's API key"
              }
              // Whole-value select on focus while at rest: click + paste
              // replaces the stored key in ONE gesture (paste-to-replace).
              onFocus={(e) => {
                if (provider.hasKey && keyDraft === null) e.currentTarget.select();
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape" && keyDraft !== null) {
                  setKeyDraft(null);
                }
                if (
                  e.key === "Enter" &&
                  keyDraft !== null &&
                  keyDraft.trim() !== "" &&
                  !saveKey.isPending
                ) {
                  saveKey.mutate(keyDraft.trim());
                }
              }}
              // ROUND-60: any typed/pasted change while at rest IS the
              // paste-to-replace gesture — the draft takes over (edit mode).
              onChange={(e) => setKeyDraft(e.target.value)}
              className="h-10 flex-1 min-w-0 rounded-[10px] border-[1.5px] px-3 font-mono text-[12px] outline-none"
              style={{
                ...inputStyle,
                borderColor:
                  keyDraft !== null
                    ? withAlpha(styles.accent, 0.55)
                    : revealState.kind === "shown"
                      ? withAlpha(styles.accent, 0.45)
                      : styles.border,
              }}
            />
            {/* THE eye toggle — the exact same slot in every state: masked
                rest → Eye (reveal), loading → spinner, revealed → EyeOff
                (mask again). Disabled while editing (the draft is the
                truth now — Cancel restores the stored display first) and
                keyless (nothing to reveal). */}
            <button
              type="button"
              onClick={() => {
                if (revealState.kind === "shown") setRevealState({ kind: "idle" });
                else void revealStoredKey();
              }}
              disabled={!provider.hasKey || keyDraft !== null || revealState.kind === "loading"}
              aria-label={revealState.kind === "shown" ? "Hide stored key" : "Show stored key"}
              data-testid={revealState.kind === "shown" ? "hide-stored-key-button" : "show-stored-key-button"}
              title={
                !provider.hasKey
                  ? "No stored key to reveal yet"
                  : revealState.kind === "shown"
                    ? "Mask the stored key again"
                    : "Show the stored key"
              }
              className="h-10 w-10 grid place-items-center rounded-[10px] border-[1.5px] shrink-0 disabled:opacity-40"
              style={{
                background: styles.bg,
                borderColor: styles.border,
                color: revealState.kind === "shown" ? styles.accent : styles.textTertiary,
              }}
            >
              {revealState.kind === "loading" ? (
                <RefreshCw size={13} className="animate-spin" />
              ) : revealState.kind === "shown" ? (
                <EyeOff size={13} />
              ) : (
                <Eye size={13} />
              )}
            </button>
            {/* Context action slot: Save key (+ Cancel X) while editing or
                keyless; otherwise Copy, which fades/slides in ONLY while
                the stored key is revealed. */}
            {keyDraft !== null || !provider.hasKey ? (
              <>
                <button
                  type="button"
                  onClick={() => {
                    if (keyDraft !== null && keyDraft.trim() !== "") saveKey.mutate(keyDraft.trim());
                  }}
                  disabled={keyDraft === null || keyDraft.trim() === "" || saveKey.isPending}
                  aria-label="Save key"
                  data-testid="save-key-button"
                  className="h-10 px-4 rounded-[10px] text-[12px] font-bold disabled:opacity-50 shrink-0"
                  style={{ background: styles.accent, color: styles.accentText }}
                >
                  {saveKey.isPending ? "Saving…" : "Save key"}
                </button>
                {provider.hasKey && (
                  <button
                    type="button"
                    onClick={() => setKeyDraft(null)}
                    aria-label="Cancel key edit"
                    data-testid="cancel-key-edit-button"
                    title="Restore the stored key display"
                    className="h-10 w-10 grid place-items-center rounded-[10px] border-[1.5px] shrink-0"
                    style={{ borderColor: styles.border, color: styles.textTertiary }}
                  >
                    <X size={13} />
                  </button>
                )}
              </>
            ) : (
              <AnimatePresence initial={false}>
                {revealedValue !== null && (
                  <motion.div
                    key="copy-stored-key"
                    initial={{ opacity: 0, width: 0 }}
                    animate={{ opacity: 1, width: "auto" }}
                    exit={{ opacity: 0, width: 0 }}
                    transition={{ duration: 0.2, ease: "easeOut" }}
                    className="overflow-hidden shrink-0"
                  >
                    <button
                      type="button"
                      onClick={() => void copyToClipboard(revealedValue, "Key copied to clipboard.")}
                      aria-label="Copy stored key"
                      data-testid="copy-stored-key-button"
                      title="Copy the stored key"
                      className="h-10 px-3.5 rounded-[10px] border-[1.5px] text-[12px] font-bold flex items-center gap-1.5 shrink-0 whitespace-nowrap"
                      style={{ borderColor: styles.border, color: styles.textSecondary }}
                    >
                      <Copy size={12} /> Copy
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>
            )}
          </div>
          {revealState.kind === "error" && (
            <p className="mt-1.5 text-[11px] break-all" style={{ color: "#ef4444" }} role="alert">
              {revealState.message}
            </p>
          )}
          {keyStatus && (
            <p
              className="mt-1.5 text-[11px]"
              style={{ color: saveKey.isError || keyStatusIsError ? "#ef4444" : "#22c55e" }}
            >
              {keyStatus}
            </p>
          )}
          <p className="mt-1 text-[10.5px]" style={{ color: styles.textTertiary }}>
            Stored in the OS secure store — never in the database or logs; Show fetches the full
            value only on your explicit click.
          </p>
          {/* ROUND-47 (R47-c1): browser-dev honesty — the sidecar keyring is
              in-memory, so browser-stored keys do not survive a restart. */}
          {!isTauri() && (
            <p className="mt-1 text-[10.5px]" style={{ color: styles.textTertiary, opacity: 0.75 }}>
              {EPHEMERAL_KEY_NOTE}
            </p>
          )}
        </div>
        {/* Test connection — ROUND-47 (R47-c1): WHICH key + WHICH model are
            explicit now (key selector over the primary + held pool slots,
            model selector over the live catalog; "(reachability only)" is
            the honest default — a cheap ping that does NOT prove the key). */}
        <div className="flex items-center gap-2.5 flex-wrap pt-1">
          <select
            aria-label="Test key"
            title="Which key the probe uses"
            value={testKeyChoice === "primary" ? "primary" : String(testKeyChoice)}
            onChange={(e) =>
              setTestKeyChoice(e.target.value === "primary" ? "primary" : Number(e.target.value))
            }
            className="h-9 rounded-[10px] border-[1.5px] px-2 text-[11.5px] font-bold outline-none cursor-pointer"
            style={{ background: styles.bg, borderColor: styles.border, color: styles.textSecondary }}
          >
            <option value="primary">Primary key</option>
            {heldPoolSlots.map((slot) => (
              <option key={slot} value={String(slot)}>
                Pool slot {slot}
              </option>
            ))}
          </select>
          <select
            aria-label="Test model"
            title="A model upgrades the ping to a real one-token completion"
            value={testModel}
            onChange={(e) => setTestModel(e.target.value)}
            disabled={catalogQuery.isFetching && catalogEntries.length === 0}
            className="h-9 max-w-[260px] rounded-[10px] border-[1.5px] px-2 text-[11.5px] font-bold outline-none cursor-pointer disabled:opacity-50"
            style={{ background: styles.bg, borderColor: styles.border, color: styles.textSecondary }}
          >
            <option value="">(reachability only)</option>
            {catalogIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
          <button
            onClick={() => void runTest()}
            disabled={testState.kind === "testing" || (testKeyChoice === "primary" && !provider.hasKey)}
            className="h-9 px-3.5 rounded-[10px] border-[1.5px] text-[12px] font-bold flex items-center gap-1.5 disabled:opacity-50"
            style={{ background: styles.bg, borderColor: styles.border, color: styles.textSecondary }}
          >
            {testState.kind === "testing" ? <RefreshCw size={12} className="animate-spin" /> : <Zap size={12} />}
            Test connection
          </button>
          {testState.kind === "ok" && (
            <span className="text-[11px] font-bold" style={{ color: "#22c55e" }}>
              <Check size={11} className="inline" /> Connected · {testState.ms}ms
              {testState.model ? ` · ${testState.model}` : ""}
            </span>
          )}
          {testState.kind === "fail" && (
            <span className="text-[11px] font-bold break-all" style={{ color: "#ef4444" }}>
              {testState.message}
            </span>
          )}
          {testKeyChoice === "primary" && !provider.hasKey && (
            <span className="text-[11px]" style={{ color: styles.textTertiary }}>
              Save a key first to test.
            </span>
          )}
          {/* the backend's own reachability-only message — surfaced, not hardcoded */}
          {testState.kind === "ok" && testState.note && (
            <span className="text-[10.5px]" style={{ color: styles.textTertiary }}>
              {testState.note}
            </span>
          )}
          {provider.apiFormat === "anthropic-messages" && (
            <span className="text-[10.5px]" style={{ color: styles.textTertiary }}>
              Connection test probes the OpenAI-compatible surface — full adapter testing is pending.
            </span>
          )}
        </div>
      </div>

      {/* ── API key pool (its own section now — R50-d) ─────────────────── */}
      <div
        className="rounded-[16px] border-[1.5px] p-4 md:p-5 flex flex-col gap-3"
        style={{ background: styles.card, borderColor: styles.border }}
      >
        <div>
          <SectionLabel>API key pool</SectionLabel>
          <p className="mt-1 text-[11px]" style={{ color: styles.textTertiary }}>
            Dedicated keys for sub-agents — the primary stays free for your main chats.
          </p>
        </div>
        {/* ROUND-36 (ADR-0022): the per-provider API key pool */}
        <KeyPoolSection providerId={provider.id} hideLabel />
      </div>

      {/* ── Models (the reworked ModelListSection — R50-d) ─────────────── */}
      <ModelListSection
        providerId={provider.id}
        models={models}
        modelsLoadError={
          // ROUND-62 (R62-2b): a failed models-config fetch renders as an
          // honest red line — not the misleading "No models yet" empty
          // state (the page is "not proper" when a dead sidecar looks
          // identical to a provider with no models).
          modelsQuery.isError
            ? modelsQuery.error instanceof Error
              ? modelsQuery.error.message
              : String(modelsQuery.error)
            : null
        }
        catalog={{
          entries: catalogEntries,
          isFetching: catalogQuery.isFetching,
          isError: catalogQuery.isError,
        }}
        staticCatalog={staticCatalog}
      />

      {/* ── Danger zone: delete provider (moved out of the header — R50-d) */}
      <div
        className="rounded-[16px] border-[1.5px] p-4 md:p-5 flex items-center gap-4 flex-wrap"
        style={{
          background: withAlpha("#ef4444", 0.03),
          borderColor: withAlpha("#ef4444", 0.25),
        }}
      >
        <span
          className="w-9 h-9 shrink-0 rounded-[10px] grid place-items-center"
          style={{ background: withAlpha("#ef4444", 0.1), color: "#ef4444" }}
          aria-hidden
        >
          <AlertTriangle size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <SectionLabel color="#ef4444">Danger zone</SectionLabel>
          <p className="mt-1 text-[11.5px]" style={{ color: styles.textSecondary }}>
            Deletes the provider, its stored key, and every model override. Agents still using
            it must be reassigned first.
          </p>
        </div>
        <button
          onClick={() => {
            if (confirmDelete) {
              removeProvider.mutate();
            } else {
              setConfirmDelete(true);
              resetAfter(() => setConfirmDelete(false), 3000);
            }
          }}
          aria-label={`Delete provider ${provider.name}`}
          title="Delete provider"
          className="h-9 px-3.5 rounded-[10px] text-[12px] font-bold flex items-center gap-1.5 transition-colors shrink-0"
          style={
            confirmDelete
              ? { background: "#ef4444", color: "#fff" }
              : { border: `1.5px solid ${withAlpha("#ef4444", 0.5)}`, color: "#ef4444" }
          }
          onMouseEnter={(e) => {
            if (!confirmDelete) e.currentTarget.style.background = withAlpha("#ef4444", 0.12);
          }}
          onMouseLeave={(e) => {
            if (!confirmDelete) e.currentTarget.style.background = "transparent";
          }}
        >
          <Trash2 size={12} /> {confirmDelete ? "Confirm delete" : "Delete provider"}
        </button>
      </div>
    </div>
  );
}

/* ── Add Provider DIALOG (ROUND-37: preset choice → fields) ───────────────── */

function AddProviderDialog({
  existingNames,
  configuredPresetIds,
  onClose,
  onCreated,
}: {
  /** R89-B1: the CONFIGURED providers' display names — the uniqueness key
   * (the owner's rule: "only the provider name should be different"). */
  existingNames: Set<string>;
  /** R89-B1: which presets already have a configured row — an info chip
   * only, never a disable: the owner may add as many same-type providers
   * as he needs ("10 OpenRouter providers") under distinct names. */
  configuredPresetIds: Set<string>;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const styles = useThemeStyles();
  const [presetId, setPresetId] = useState<string | null>(null);
  const preset = PRESETS.find((p) => p.id === presetId) ?? null;
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiFormat, setApiFormat] = useState("chat-completions");
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choosePreset = (id: string) => {
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return;
    setPresetId(id);
    setName(p.id === "custom" ? "" : p.name);
    setBaseUrl(p.baseUrl);
    setApiFormat(p.apiFormat);
    setError(null);
  };

  const isPreset = presetId !== null && presetId !== "custom";
  // R89-B1: the name is the identity — live feedback the moment it collides
  // with a configured provider (the backend 409s on body.name as backstop).
  const nameTaken = name.trim().length > 0 && existingNames.has(name.trim());

  const create = useMutation({
    mutationFn: async (): Promise<{ id: string; keyError?: string }> => {
      // ROUND-47 (R47-c1): the canonical api.ts fn — same wire shape the
      // dialog always sent (name / baseUrl / apiFormat / preset id; the key
      // NEVER rides in the create body — it goes to the dedicated key route
      // or the Tauri shell so no create/list envelope can leak it).
      const created = await createProvider({
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        apiFormat,
        // Presets carry their reserved id — a KEYLESS row at that id is
        // ADOPTED server-side (R89-B1); a configured one derives a fresh
        // id from the name (same-type adds).
        ...(isPreset ? { id: presetId } : {}),
      });
      if (key.trim()) {
        // Under Tauri, keys MUST route through the shell into the OS secure
        // store (ADR-0012) — same branch as the detail pane. R37 review #8:
        // a key-store failure must NOT strand the dialog (the provider
        // exists now) — surface it and continue to the detail pane, where
        // the key status shows un-stored and can be retried.
        try {
          if (isTauri()) {
            const { storeProviderKey: storeViaShell } = await import("../onboarding/providers-api");
            const ok = await storeViaShell(created.id, key.trim());
            if (!ok) return { id: created.id, keyError: "the shell refused the key store request" };
          } else {
            await storeProviderKey(created.id, key.trim());
          }
        } catch (err) {
          return { id: created.id, keyError: err instanceof Error ? err.message : String(err) };
        }
      }
      return { id: created.id };
    },
    onSuccess: ({ id, keyError }) => {
      if (keyError !== undefined) {
        // The provider EXISTS now — close the dialog and select it; the
        // detail pane shows "no key stored" and the key can be retried.
        console.warn(`[add-provider] key not stored: ${keyError}`);
      }
      onCreated(id);
    },
    onError: (err: Error) => setError(err.message),
  });

  const inputStyle = {
    background: styles.bg,
    borderColor: styles.border,
    color: styles.text,
  } as const;
  const valid = name.trim().length > 0 && !nameTaken && /^https?:\/\/.+/.test(baseUrl.trim());

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: "rgba(0,0,0,0.35)", backdropFilter: "blur(4px)" }}
      role="dialog"
      aria-modal="true"
      aria-label="Add provider"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-full max-w-[520px] max-h-[86vh] overflow-y-auto auto-scroll rounded-[20px] border-[1.5px] p-5 flex flex-col gap-4"
        style={{ background: styles.card, borderColor: styles.border, boxShadow: styles.bentoShadow }}
      >
        {preset === null ? (
          <>
            {/* STEP 1: what kind of provider? (owner: "is he going to add a
                custom provider or is he going to add others from the list") */}
            <div className="flex items-center gap-2">
              <span className="text-[16px] font-black" style={{ color: styles.text }}>
                Add provider
              </span>
              <span className="flex-1" />
              <button
                onClick={onClose}
                aria-label="Close"
                className="w-7 h-7 grid place-items-center rounded-[8px]"
                style={{ color: styles.textTertiary }}
              >
                <X size={14} />
              </button>
            </div>
            <p className="text-[12px] -mt-2" style={{ color: styles.textSecondary }}>
              Pick a preset to prefill, or start from scratch with a custom endpoint.
            </p>
            <div className="flex flex-col gap-2">
              {PRESETS.map((p) => {
                const configured = p.id !== "custom" && configuredPresetIds.has(p.id);
                return (
                  <button
                    key={p.id}
                    onClick={() => choosePreset(p.id)}
                    className="h-12 px-4 rounded-[12px] border-[1.5px] flex items-center gap-3 text-left transition-colors"
                    style={{ borderColor: styles.border, background: styles.bg, color: styles.text }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.borderColor = withAlpha(styles.accent, 0.5);
                    }}
                    onMouseLeave={(e) => (e.currentTarget.style.borderColor = styles.border)}
                  >
                    <span
                      className="w-8 h-8 shrink-0 rounded-[10px] grid place-items-center"
                      style={{ background: withAlpha(styles.accent, 0.1), color: styles.accent }}
                      aria-hidden
                    >
                      <Globe size={14} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-bold truncate">{p.name}</span>
                      <span className="block text-[11px] truncate" style={{ color: styles.textTertiary }}>
                        {p.blurb}
                      </span>
                    </span>
                    {configured ? (
                      <span
                        className="shrink-0 text-[10px] font-bold px-2 py-0.5 rounded-full"
                        style={{ background: withAlpha("#22c55e", 0.12), color: "#22c55e" }}
                        title="Already configured — you can still add another one under a different name"
                      >
                        configured
                      </span>
                    ) : null}
                    <span className="shrink-0 text-[11px] font-bold" style={{ color: styles.accent }}>
                      Add →
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        ) : (
          <>
            {/* STEP 2: the fields (name / base URL / format / key) */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  setPresetId(null);
                  setError(null);
                }}
                aria-label="Back to presets"
                className="w-7 h-7 grid place-items-center rounded-[8px]"
                style={{ color: styles.textTertiary }}
              >
                <ArrowLeft size={14} />
              </button>
              <span className="text-[16px] font-black" style={{ color: styles.text }}>
                {preset.id === "custom" ? "Custom provider" : preset.name}
              </span>
              <span className="flex-1" />
              <button
                onClick={onClose}
                aria-label="Close"
                className="w-7 h-7 grid place-items-center rounded-[8px]"
                style={{ color: styles.textTertiary }}
              >
                <X size={14} />
              </button>
            </div>

            <div>
              <label className="mb-1.5 block text-[11px] font-bold" style={{ color: styles.textSecondary }}>
                Provider name
              </label>
              <input
                autoFocus
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setError(null);
                }}
                placeholder={presetId !== null && presetId !== "custom" ? `${preset?.name} 2` : "My Gateway"}
                aria-label="Provider name"
                aria-invalid={nameTaken}
                className="h-10 w-full rounded-[10px] border-[1.5px] px-3 text-[13px] outline-none"
                style={{
                  ...inputStyle,
                  ...(nameTaken ? { borderColor: "#ef4444" } : {}),
                }}
              />
              {nameTaken ? (
                <p className="mt-1.5 text-[10.5px]" style={{ color: "#ef4444" }} role="alert">
                  That name is already in use — every provider needs a distinct display name.
                </p>
              ) : (
                <p className="mt-1.5 text-[10.5px]" style={{ color: styles.textTertiary }}>
                  The display name is the only thing that must be unique.
                </p>
              )}
            </div>
            <div>
              <label className="mb-1.5 block text-[11px] font-bold" style={{ color: styles.textSecondary }}>
                Base URL
              </label>
              <input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.example.com/v1"
                aria-label="Base URL"
                className="h-10 w-full rounded-[10px] border-[1.5px] px-3 font-mono text-[12px] outline-none"
                style={inputStyle}
              />
            </div>
            {isPreset ? (
              /* R89-B2 (the owner's verdict: "it was asking me for the API
               * Format — it should already know which API format the NVIDIA
               * provider requires and it should have it preset"): presets
               * carry a FIXED wire format — show it as a read-only summary,
               * never a choice. */
              <div className="flex items-center gap-2">
                <span
                  className="text-[10.5px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full"
                  style={{
                    background: withAlpha(styles.accent, 0.08),
                    color: styles.textSecondary,
                  }}
                >
                  {formatLabel(apiFormat)}
                </span>
                <span className="text-[10.5px]" style={{ color: styles.textTertiary }}>
                  preset for {preset?.name} — nothing to pick
                </span>
              </div>
            ) : (
              <div>
                <label className="mb-1.5 block text-[11px] font-bold" style={{ color: styles.textSecondary }}>
                  API format
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {API_FORMATS.map((f) => {
                    const active = apiFormat === f.id;
                    return (
                      <button
                        key={f.id}
                        onClick={() => setApiFormat(f.id)}
                        aria-pressed={active}
                        title={f.hint}
                        className="h-9 rounded-[10px] border-[1.5px] text-[11.5px] font-bold transition-colors"
                        style={{
                          borderColor: active ? withAlpha(styles.accent, 0.55) : styles.border,
                          background: active ? withAlpha(styles.accent, 0.09) : styles.bg,
                          color: active ? styles.accent : styles.textSecondary,
                        }}
                      >
                        {f.label}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-1.5 text-[10.5px]" style={{ color: styles.textTertiary }}>
                  {API_FORMATS.find((f) => f.id === apiFormat)?.hint}
                </p>
              </div>
            )}
            <div>
              <label className="mb-1.5 block text-[11px] font-bold" style={{ color: styles.textSecondary }}>
                API key <span style={{ color: styles.textTertiary }}>(optional — can be added later)</span>
              </label>
              <div className="relative">
                <input
                  type={showKey ? "text" : "password"}
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder="sk-…"
                  aria-label="API key"
                  className="h-10 w-full rounded-[10px] border-[1.5px] px-3 pr-10 font-mono text-[12px] outline-none"
                  style={inputStyle}
                />
                <button
                  onClick={() => setShowKey((v) => !v)}
                  aria-label={showKey ? "Hide key" : "Show key"}
                  className="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 grid place-items-center rounded-md"
                  style={{ color: styles.textTertiary }}
                >
                  {showKey ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
              </div>
            </div>

            {error && (
              <p role="alert" className="text-[12px]" style={{ color: "#ef4444" }}>
                {error}
              </p>
            )}

            <button
              onClick={() => create.mutate()}
              disabled={!valid || create.isPending}
              className="h-11 rounded-full text-[13px] font-bold disabled:opacity-50 transition-transform hover:scale-[1.01] active:scale-[0.99]"
              style={{ background: styles.accent, color: styles.accentText }}
            >
              {create.isPending ? "Adding…" : "Add provider"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/* ── Model list ─────────────────────────────────────────────────────────── */

/** One row in the Settings model list: a DB override row (configured) and/or
 * a live-fetched catalog entry. Configured rows carry the server row id and
 * are fully editable; catalog-only entries render read-only until configured
 * (ROUND-50: enriched with the served catalog's pricing/ctx preview). */
interface MergedModel {
  /** Server models-table row id — null for catalog-only entries. */
  rowId: string | null;
  modelId: string;
  displayName: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  inputPricePerMtok: number | null;
  inputPriceCachedPerMtok: number | null;
  outputPricePerMtok: number | null;
  supportsThinking: boolean;
  hidden: boolean;
  configured: boolean;
}

/** DB override rows as list rows. ROUND-60 (R60-B): the caller passes []
 * for catalogIds ALWAYS — the R43/R50/R58 catalog→list merge is gone (the
 * owner: models appear ONLY after being manually added); the live catalog
 * feeds the "Add models" picker alone. The MergedModel shape keeps the
 * catalog fields so the row renderer stays one type. */
function mergeCatalogIntoModels(
  configured: ProviderModelConfig[],
  catalogIds: string[],
  staticCatalog: CatalogModel[],
): MergedModel[] {
  const staticById = new Map(staticCatalog.map((m) => [m.modelId, m]));
  const merged: MergedModel[] = configured.map((m) => ({
    rowId: m.id,
    modelId: m.modelId,
    displayName: m.displayName || m.modelId,
    contextWindow: m.contextWindow,
    maxOutputTokens: m.maxOutputTokens,
    inputPricePerMtok: m.inputPricePerMtok,
    inputPriceCachedPerMtok: m.inputPriceCachedPerMtok,
    outputPricePerMtok: m.outputPricePerMtok,
    supportsThinking: m.supportsThinking,
    hidden: m.hidden,
    configured: true,
  }));
  const seen = new Set(configured.map((m) => m.modelId));
  for (const id of catalogIds) {
    if (seen.has(id)) continue;
    const meta = staticById.get(id);
    merged.push({
      rowId: null,
      modelId: id,
      displayName: meta?.displayName ?? id,
      contextWindow: meta?.contextWindow ?? null,
      maxOutputTokens: meta?.maxOutputTokens ?? null,
      inputPricePerMtok: meta?.inputPricePerMtok ?? null,
      inputPriceCachedPerMtok: meta?.inputPriceCachedPerMtok ?? null,
      outputPricePerMtok: meta?.outputPricePerMtok ?? null,
      supportsThinking: false,
      hidden: false,
      configured: false,
    });
  }
  return merged;
}

/** The provider's LIVE catalog, passed down from the detail pane (ROUND-47
 * R47-c1: hoisted so the connection-test model selector shares the query;
 * ROUND-50 R50-d: entries now carry display names for the picker). */
interface ProviderCatalogState {
  entries: ProviderModelCatalogEntry[];
  isFetching: boolean;
  isError: boolean;
}

// ── ROUND-82 (R82, owner: "a test button … check if the model is working
//    properly or not … not only check for a response, but also check if the
//    response is reasonable"): the PER-MODEL test button. Local state only
//    (a running test never re-renders the whole list); one test at a time
//    per row (the probe spends ~64 output tokens on paid models — the cap
//    the spec chose over a server-side rate limit for a single-user desktop
//    app). The result line wraps BELOW the row (the row gained flex-wrap)
//    so the full raw reason (the R77-style expand toggle) never squeezes
//    the columns. ──────────────────────────────────────────────────────────
function ModelTestButton({ model }: { model: ProviderModelConfig }) {
  const styles = useThemeStyles();
  type TestState =
    | { kind: "idle" }
    | { kind: "testing" }
    | { kind: "pass"; latencyMs: number; preview?: string; usage?: { inputTokens: number; outputTokens: number } }
    | { kind: "fail"; reason: string };
  const [state, setState] = useState<TestState>({ kind: "idle" });
  const [showFull, setShowFull] = useState(false);
  const [showReply, setShowReply] = useState(false);

  // ROUND-87 (R87, owner: "when I click the test button it should show an
  // animation. After testing it, it should show the results … the results
  // should disappear automatically after 5 seconds … After 5 seconds the
  // test button's color will be changed slightly green or slightly red
  // depending on whether it was successful or not"): the RESULT LINE and
  // the button TINT both fade away after 5s (a fresh test re-arms both —
  // clicking again resets the timer). The tint rides the button's own
  // background with a 300ms transition.
  const [showResult, setShowResult] = useState(false);
  const [tinted, setTinted] = useState(false);
  useEffect(() => {
    if (state.kind !== "pass" && state.kind !== "fail") return;
    setShowResult(true);
    setTinted(true);
    const hide = setTimeout(() => {
      setShowResult(false);
      setTinted(false);
    }, 5_000);
    return () => clearTimeout(hide);
  }, [state]);

  const run = (): void => {
    setState({ kind: "testing" });
    setShowFull(false);
    setShowReply(false);
    setShowResult(false);
    setTinted(false);
    testModelConnection(model.id)
      .then((result) => {
        if (result.ok) {
          setState({
            kind: "pass",
            latencyMs: result.latencyMs,
            ...(result.contentPreview !== undefined ? { preview: result.contentPreview } : {}),
            ...(result.usage !== undefined ? { usage: result.usage } : {}),
          });
        } else {
          setState({
            kind: "fail",
            reason: result.reason ?? "the probe failed without a reason",
          });
        }
      })
      .catch((err: unknown) => {
        // ApiError — 409 (no key / provider gone) or 502 (transport). The
        // message is the honest envelope text (R77 discipline).
        setState({
          kind: "fail",
          reason: err instanceof Error ? err.message : String(err),
        });
      });
  };

  const testing = state.kind === "testing";
  const outcome = state.kind === "pass" ? "pass" : state.kind === "fail" ? "fail" : null;

  return (
    <>
      <button
        onClick={run}
        disabled={testing}
        aria-label={`Test model ${model.displayName || model.modelId}`}
        title="Send a real test request to this model — checks the key, the model id, and the reply"
        data-testid="model-test-button"
        data-model-row={model.id}
        className="h-8 w-8 grid place-items-center rounded-[10px] shrink-0 text-[11px] font-bold transition-colors duration-300"
        style={{
          color: outcome === "pass" ? "#16a34a" : outcome === "fail" ? "#ef4444" : styles.textSecondary,
          background: tinted
            ? outcome === "pass"
              ? withAlpha("#22c55e", 0.14)
              : withAlpha("#ef4444", 0.12)
            : "transparent",
          borderColor: "transparent",
        }}
        onMouseEnter={(e) => {
          if (!tinted) e.currentTarget.style.background = withAlpha(styles.accent, 0.1);
        }}
        onMouseLeave={(e) => {
          if (!tinted) e.currentTarget.style.background = "transparent";
        }}
      >
        {testing ? (
          <span className="grid place-items-center ac-pulse" aria-hidden>
            <RefreshCw size={12} className="animate-spin" />
          </span>
        ) : tinted && outcome === "pass" ? (
          <Check size={12} strokeWidth={2.5} />
        ) : tinted && outcome === "fail" ? (
          <AlertTriangle size={12} />
        ) : (
          <Zap size={12} />
        )}
      </button>
      {/* ROUND-87 (R87): the result line — now ANIMATED (AnimatePresence
       * slide-down) and AUTO-DISMISSING (5s; a fresh test re-arms it). */}
      <AnimatePresence>
        {showResult && state.kind !== "idle" && state.kind !== "testing" && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.22, ease }}
            className="w-full min-w-0 px-1 pb-1 overflow-hidden"
            data-testid="model-test-result"
            data-model-test={state.kind}
          >
            {state.kind === "pass" ? (
              <div className="flex flex-col gap-0.5 min-w-0">
                <div className="flex items-center gap-2 flex-wrap text-[10.5px]">
                  <span className="font-bold" style={{ color: "#22c55e" }}>
                    ✓ responded in {state.latencyMs}ms
                  </span>
                  {state.usage !== undefined && (
                    <span className="font-mono" style={{ color: styles.textTertiary }}>
                      {state.usage.inputTokens} in / {state.usage.outputTokens} out
                    </span>
                  )}
                  {state.preview !== undefined && (
                    <button
                      onClick={() => setShowReply(!showReply)}
                      className="font-bold underline underline-offset-2"
                      style={{ color: styles.textTertiary }}
                      data-testid="model-test-show-reply"
                    >
                      {showReply ? "Hide reply" : "Show reply"}
                    </button>
                  )}
                </div>
                {showReply && state.preview !== undefined && (
                  <div
                    className="font-mono text-[10.5px] break-all rounded-[6px] px-2 py-1 max-h-24 overflow-y-auto"
                    style={{ background: styles.subtle, color: styles.textSecondary }}
                  >
                    {state.preview}
                  </div>
                )}
              </div>
            ) : (
              <div className="flex flex-col gap-0.5 min-w-0">
                <div
                  className="text-[10.5px] break-all"
                  style={{ color: "#ef4444" }}
                  data-testid="model-test-reason"
                >
                  {showFull ? state.reason : `${state.reason.slice(0, 240)}${state.reason.length > 240 ? "…" : ""}`}
                </div>
                {state.reason.length > 240 && (
                  <button
                    onClick={() => setShowFull(!showFull)}
                    className="text-[10.5px] font-bold underline underline-offset-2 self-start"
                    style={{ color: styles.textTertiary }}
                    data-testid="model-test-show-full"
                  >
                    {showFull ? "Show less" : "Show full error"}
                  </button>
                )}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

function ModelListSection({
  providerId,
  models,
  modelsLoadError,
  catalog,
  staticCatalog,
}: {
  providerId: string;
  models: ProviderModelConfig[];
  /** ROUND-62 (R62-2b): the models-config query's error message, null when
   * the load succeeded (the empty list then genuinely means "none added"). */
  modelsLoadError: string | null;
  catalog: ProviderCatalogState;
  staticCatalog: CatalogModel[];
}) {
  const styles = useThemeStyles();
  const queryClient = useQueryClient();
  // ROUND-50 (R50-d): the "Add models" picker dialog + the per-model
  // configuration dialog (replaces the inline type-an-id row editor).
  // ROUND-87 (R87): `adding` — the ADD-mode config dialog opened by picking
  // a model in the picker (configure BEFORE the upsert, per the owner).
  const [pickerOpen, setPickerOpen] = useState(false);
  const [configuring, setConfiguring] = useState<ProviderModelConfig | null>(null);
  const [adding, setAdding] = useState<ModelAddPrefill | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ROUND-60 (R60-B): the list shows CONFIGURED (stored) rows ONLY — the
  // R58/R50 catalog→list merge is GONE (the owner: "By default none of the
  // models should be added there… By default there should not be the free
  // models or all models there at all. I should be able to manually add
  // the models and only after that they will be shown there"). The live
  // catalog feeds the "Add models" picker ALONE — catalogIds is [] by
  // design; the static catalog stays a param for the picker pre-fill.
  const merged = mergeCatalogIntoModels(models, [], staticCatalog);

  // ROUND-62 (R62-2b): model-config mutations fan out to the session
  // page's ["provider-models-config"] family (the rename/hide/pricing
  // staleness fix) — the helper keeps the settings-side invalidation.
  const invalidate = () => invalidateModelConfigEverywhere(queryClient, providerId);

  const deleteModel = useMutation({
    mutationFn: (id: string) => deleteProviderModelConfig(id),
    onSuccess: invalidate,
    onError: (err: Error) => setError(err.message),
  });

  return (
    <div className="rounded-[16px] border-[1.5px] overflow-hidden" style={{ background: styles.card, borderColor: styles.border }}>
      <div className="flex items-center gap-2 px-4 py-3 border-b flex-wrap" style={{ borderColor: styles.border }}>
        <SectionLabel>Models</SectionLabel>
        {/* ROUND-60 (R60-B): the count is the CONFIGURED row count only —
            catalog entries are picker-only now (the free/all scope moved
            into the picker as the Free only ↔ All models toggle). */}
        <span data-testid="models-count" className="font-mono text-[10px]" style={{ color: styles.textTertiary }}>
          {merged.length}
        </span>
        <span className="flex-1" />
        {/* ROUND-50 (R50-d): "Add models" opens the catalog picker dialog
            (multi-select from the provider's live catalog, with a manual
            add-by-id fallback) — replacing the type-an-id inline form. */}
        <button
          onClick={() => setPickerOpen(true)}
          className="h-7 px-2.5 rounded-full text-[11px] font-bold flex items-center gap-1"
          style={{ background: withAlpha(styles.accent, 0.1), color: styles.accent }}
        >
          <Plus size={11} strokeWidth={2.5} /> Add models
        </button>
      </div>

      {error && (
        <div className="px-4 py-2 border-b text-[11px]" style={{ borderColor: styles.border, color: "#ef4444" }}>
          {error}
        </div>
      )}

      {/* ROUND-62 (R62-2b): the load error replaces the empty state — an
          unreachable models-config must never read as "no models added". */}
      {modelsLoadError !== null && (
        <div
          role="alert"
          className="px-4 py-3 text-[11.5px]"
          style={{ color: "#ef4444" }}
        >
          Couldn&apos;t load this provider&apos;s models — {modelsLoadError}
        </div>
      )}

      {modelsLoadError === null && merged.length === 0 ? (
        <div className="px-4 py-6 text-center text-[12px]" style={{ color: styles.textTertiary }}>
          No models yet — use “Add models” to pick from the provider's catalog.
        </div>
      ) : (
        <div className="flex flex-col gap-2.5 p-3">
          {merged.map((m) => (
            <div
              key={m.rowId ?? `cat:${m.modelId}`}
              // ROUND-87 (R87, owner: "the models should be shown properly. The
              // display name should be shown properly for the model and it
              // should be given in a dedicated section with borders around
              // it"): every model is now its own BORDERED CARD (rounded-14,
              // 1.5px border, generous padding) instead of a cramped list
              // row — and the three right-side actions are uniform 8×8
              // rounded icon buttons. The test result line still wraps BELOW
              // (flex-wrap) inside the card.
              className="flex flex-wrap items-center gap-3 rounded-[14px] border-[1.5px] px-4 py-3"
              style={{
                borderColor: m.configured ? styles.border : withAlpha(styles.accent, 0.3),
                background: styles.isDark ? "rgba(255,255,255,0.015)" : "rgba(0,0,0,0.01)",
              }}
            >
              {/* left: name + badges / id + pricing summary (R50-d) */}
              <div className="min-w-0 flex-1 flex flex-col gap-1">
                <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
                  <span
                    className="truncate text-[13.5px] font-bold"
                    style={{ color: m.configured ? styles.text : styles.textSecondary }}
                    title={m.modelId}
                  >
                    {m.displayName || m.modelId}
                  </span>
                  {isFreeModelEntry(m) && (
                    <span
                      className="shrink-0 px-1.5 py-0.5 rounded-full text-[10px] font-bold"
                      style={{ background: withAlpha("#22c55e", 0.12), color: "#22c55e" }}
                    >
                      FREE
                    </span>
                  )}
                  {/* ROUND-87 (R87): the capability chips — the honest,
                      user-set input/output flags (the THINKING badge is gone
                      with the dialog's reasoning toggle: the app DETECTS
                      reasoning, the user never configures it). */}
                  {m.configured && capabilityChips(models.find((row) => row.id === m.rowId)).map((chip) => (
                    <span
                      key={chip.label}
                      className="shrink-0 px-1.5 py-0.5 rounded-full text-[10px] font-bold"
                      style={{ background: withAlpha(chip.color, 0.12), color: chip.color }}
                      title={chip.title}
                    >
                      {chip.label}
                    </span>
                  ))}
                  {m.hidden && (
                    <span
                      className="shrink-0 px-1.5 py-0.5 rounded-full text-[10px] font-bold"
                      style={{ background: styles.subtle, color: styles.textTertiary }}
                      title="Hidden from the chat model picker (still visible here)"
                    >
                      HIDDEN
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 min-w-0 flex-wrap">
                  <span
                    className="truncate font-mono text-[10px]"
                    style={{ color: styles.textTertiary }}
                    title={m.modelId}
                  >
                    {m.modelId}
                  </span>
                  {m.contextWindow !== null && (
                    <span
                      className="shrink-0 px-1.5 py-0.5 rounded-full font-mono text-[10px]"
                      style={{ background: styles.subtle, color: styles.textTertiary }}
                    >
                      {formatContextWindow(m.contextWindow)}
                    </span>
                  )}
                  {/* compact pricing summary — mono micro-type (R50-d) */}
                  {formatPricingSummary(m) !== null ? (
                    <span className="shrink-0 font-mono text-[10px]" style={{ color: styles.textTertiary }}>
                      {formatPricingSummary(m)}
                    </span>
                  ) : (
                    <span className="shrink-0 font-mono text-[10px] italic" style={{ color: styles.textTertiary, opacity: 0.7 }}>
                      pricing not set
                    </span>
                  )}
                </div>
              </div>
              {m.configured && m.rowId !== null && (
                <div className="flex items-center gap-1 shrink-0">
                  {/* ROUND-87 (R87, owner: "the three buttons on the right side
                      should be handled much more properly"): uniform 8×8
                      rounded-[10px] icon buttons — TEST (animated, 5s tint),
                      EDIT, DELETE (danger-tinted hover), consistent titles. */}
                  <ModelTestButton model={models.find((row) => row.id === m.rowId)!} />
                  <button
                    onClick={() => {
                      const row = models.find((row) => row.id === m.rowId);
                      if (row) setConfiguring(row);
                    }}
                    aria-label={`Configure model ${m.displayName || m.modelId}`}
                    title="Configure — display name, capabilities, pricing, limits"
                    className="h-8 w-8 grid place-items-center rounded-[10px] shrink-0 transition-colors"
                    style={{ color: styles.textSecondary }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = withAlpha(styles.accent, 0.1))}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    onClick={() => {
                      if (window.confirm(`Delete model "${m.displayName || m.modelId}"?`)) deleteModel.mutate(m.rowId!);
                    }}
                    aria-label={`Delete model ${m.displayName || m.modelId}`}
                    title="Delete this model"
                    className="h-8 w-8 grid place-items-center rounded-[10px] shrink-0 transition-colors"
                    style={{ color: styles.textTertiary }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = withAlpha("#ef4444", 0.12))}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ROUND-50 (R50-d): the catalog-driven picker + the per-model config
          dialog. Both invalidate THIS provider's models query on change.
          ROUND-87 (R87): clicking a model in the picker now opens the
          CONFIG dialog (add mode) instead of adding directly. */}
      {pickerOpen && (
        <AddModelsDialog
          providerId={providerId}
          catalog={catalog}
          staticCatalog={staticCatalog}
          configuredIds={new Set(models.map((m) => m.modelId))}
          onPick={(prefill) => {
            setPickerOpen(false);
            setAdding(prefill);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
      {configuring && (
        <ModelConfigDialog
          providerId={providerId}
          model={configuring}
          prefill={null}
          onClose={() => setConfiguring(null)}
          onSaved={() => {
            invalidate();
            setConfiguring(null);
          }}
        />
      )}
      {adding !== null && (
        <ModelConfigDialog
          providerId={providerId}
          model={null}
          prefill={adding}
          onClose={() => setAdding(null)}
          onSaved={() => {
            invalidate();
            setAdding(null);
          }}
        />
      )}
    </div>
  );
}

/* ── ROUND-50 (R50-d): the "Add models" catalog picker dialog ─────────────── */

function AddModelsDialog({
  catalog,
  staticCatalog,
  configuredIds,
  onPick,
  onClose,
}: {
  /** The provider being picked for (kept in the call-site shape for
   * symmetry with the sibling dialogs; the picker itself routes through
   * the parent’s onPick). */
  providerId: string;
  catalog: ProviderCatalogState;
  staticCatalog: CatalogModel[];
  configuredIds: Set<string>;
  /** ROUND-87 (R87, owner: "when I click on any of the models … it should
   * show me the options to configure that model"): picking a model hands the
   * catalog prefill to the parent, which opens the ADD-mode config dialog. */
  onPick: (prefill: ModelAddPrefill) => void;
  onClose: () => void;
}) {
  const styles = useThemeStyles();
  const [query, setQuery] = useState("");
  const [manualId, setManualId] = useState("");
  // ROUND-60 (R60-B): the Free only ↔ All models scope toggle — moved INTO
  // the picker from the models list header (the owner: "in the add model for
  // the open router, there should be an option to switch between free only
  // and all models properly").
  // ROUND-82 (R82, §2.4.6 — the NVIDIA gap): the scope is now LOCAL to the
  // dialog (initialized from the shared pref) — a provider whose catalog has
  // ZERO free-classified entries (NIM) auto-switches to All; the shared pref
  // the composer flyout reads is never silently flipped by that auto-switch.
  const [freeOnly, setFreeOnly] = useState(useSettingsStore.getState().modelsFreeOnly);

  const staticById = useMemo(
    () => new Map(staticCatalog.map((m) => [m.modelId, m])),
    [staticCatalog],
  );

  const q = query.trim().toLowerCase();
  // ROUND-82: the free-entry count for the auto-switch (pre-search — the
  // catalog's classification, not the query's filter).
  const catalogFreeCount = catalog.entries.filter((entry) => {
    const meta = staticById.get(entry.id);
    return meta ? meta.free : isFreeModelEntry({ modelId: entry.id });
  }).length;
  useEffect(() => {
    if (freeOnly && catalogFreeCount === 0) setFreeOnly(false);
  }, [freeOnly, catalogFreeCount]);
  // ROUND-60: free-only filters BEFORE the 300-row sanity cap — `free`
  // prefers the served catalog's flag, falling back to the id heuristic.
  const rows = catalog.entries
    .filter(
      (entry) =>
        q === "" ||
        entry.id.toLowerCase().includes(q) ||
        entry.name.toLowerCase().includes(q),
    )
    .filter((entry) => {
      if (!freeOnly) return true;
      const meta = staticById.get(entry.id);
      return meta ? meta.free : isFreeModelEntry({ modelId: entry.id });
    })
    .slice(0, 300); // sanity cap — the live OpenRouter catalog is huge

  /** ROUND-87 (R87): the prefill a picked model hands to the config dialog —
   * the provider's own display name first, then the static catalog's
   * pricing/context/vision knowledge. */
  const prefillFor = (id: string): ModelAddPrefill => {
    const meta = staticById.get(id);
    const entry = catalog.entries.find((e) => e.id === id);
    return {
      modelId: id,
      displayName:
        entry && entry.name !== "" && entry.name !== id
          ? entry.name
          : meta?.displayName,
      ...(meta
        ? {
            contextWindow: meta.contextWindow,
            maxOutputTokens: meta.maxOutputTokens,
            inputPricePerMtok: meta.inputPricePerMtok,
            inputPriceCachedPerMtok: meta.inputPriceCachedPerMtok,
            outputPricePerMtok: meta.outputPricePerMtok,
            supportsVision: meta.supportsVision,
          }
        : {}),
    };
  };

  const inputStyle = {
    background: styles.bg,
    borderColor: styles.border,
    color: styles.text,
  } as const;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: "rgba(0,0,0,0.35)", backdropFilter: "blur(4px)" }}
      role="dialog"
      aria-modal="true"
      aria-label="Add models"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-full max-w-[560px] max-h-[82vh] rounded-[20px] border-[1.5px] flex flex-col overflow-hidden"
        style={{ background: styles.card, borderColor: styles.border, boxShadow: styles.bentoShadow }}
      >
        {/* header */}
        <div className="flex items-center gap-2 px-5 pt-4 pb-3 shrink-0">
          <span className="text-[15px] font-black" style={{ color: styles.text }}>
            Add models
          </span>
          <span className="flex-1" />
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-7 h-7 grid place-items-center rounded-[8px]"
            style={{ color: styles.textTertiary }}
          >
            <X size={14} />
          </button>
        </div>
        <p className="px-5 pb-3 text-[11.5px] shrink-0" style={{ color: styles.textSecondary }}>
          Pick a model to configure — known pricing, context windows, and limits arrive pre-filled and stay
          editable before it&apos;s added.
        </p>

        {/* search + the ROUND-60 (R60-B) Free only ↔ All models scope toggle */}
        <div className="px-5 pb-2 shrink-0 flex items-center gap-2">
          <div className="relative flex-1 min-w-0">
            <Search
              size={13}
              className="absolute left-3 top-1/2 -translate-y-1/2"
              style={{ color: styles.textTertiary }}
              aria-hidden
            />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by model id or name…"
              aria-label="Search catalog models"
              className="h-10 w-full rounded-[14px] border-[1.5px] pl-9 pr-3 text-[12.5px] outline-none"
              style={inputStyle}
            />
          </div>
          {/* Same segmented visual language the rest of the app uses
              (SubAgentsTab / ModelSelector) — ROUND-82: the toggle rides the
              dialog-LOCAL scope (auto-switches to All for zero-free catalogs;
              the shared pref is initialized from, never written to). */}
          <div
            role="group"
            aria-label="Catalog filter"
            className="flex items-center rounded-[14px] border-[1.5px] overflow-hidden shrink-0"
            style={{ borderColor: styles.border }}
          >
            {([
              { id: "free", label: "Free only", active: freeOnly, pick: () => setFreeOnly(true) },
              { id: "all", label: "All models", active: !freeOnly, pick: () => setFreeOnly(false) },
            ] as const).map((seg) => (
              <button
                key={seg.id}
                onClick={seg.pick}
                aria-pressed={seg.active}
                data-testid={seg.id === "free" ? "picker-free-only-toggle" : "picker-all-models-toggle"}
                className="h-10 px-2.5 text-[11px] font-bold transition-colors whitespace-nowrap"
                style={{
                  background: seg.active ? withAlpha(styles.accent, 0.12) : "transparent",
                  color: seg.active ? styles.accent : styles.textTertiary,
                }}
              >
                {seg.label}
              </button>
            ))}
          </div>
        </div>

        {/* the catalog rows — ROUND-87 (R87): every row is a CLEAN clickable
            card (rounded-12, hover accent tint) that hands the prefill to the
            parent's ADD-mode config dialog. The multi-select checkboxes are
            GONE: every add goes through configuration, exactly as asked. */}
        <div className="flex-1 min-h-0 overflow-y-auto auto-scroll px-3 pb-3 flex flex-col gap-1">
          {catalog.isFetching && catalog.entries.length === 0 && (
            <div className="px-2 py-4 text-[11.5px] flex items-center gap-2" style={{ color: styles.textTertiary }}>
              <RefreshCw size={12} className="animate-spin" /> Fetching the provider catalog…
            </div>
          )}
          {!catalog.isFetching && catalog.entries.length === 0 && (
            <div className="px-2 py-4 text-[11.5px]" style={{ color: styles.textTertiary }}>
              {catalog.isError
                ? "The live catalog is unreachable for this provider — add a model by id below."
                : "This provider serves no catalog — add a model by id below."}
            </div>
          )}
          {rows.map((entry) => {
            const meta = staticById.get(entry.id);
            const alreadyAdded = configuredIds.has(entry.id);
            const free = meta ? meta.free : isFreeModelEntry({ modelId: entry.id });
            return (
              <button
                type="button"
                key={entry.id}
                disabled={alreadyAdded}
                onClick={() => onPick(prefillFor(entry.id))}
                aria-label={`Configure and add ${entry.id}`}
                data-testid="picker-model-row"
                data-model-id={entry.id}
                className="flex items-center gap-3 px-3 py-2.5 rounded-[12px] border-[1.5px] text-left transition-all enabled:hover:scale-[1.01] enabled:active:scale-[0.99]"
                style={{
                  borderColor: alreadyAdded ? styles.border : withAlpha(styles.accent, alreadyAdded ? 0 : 0.28),
                  background: alreadyAdded ? "transparent" : styles.isDark ? "rgba(255,255,255,0.015)" : "rgba(0,0,0,0.008)",
                  opacity: alreadyAdded ? 0.55 : 1,
                  cursor: alreadyAdded ? "default" : "pointer",
                }}
                title={alreadyAdded ? "Already added" : entry.id}
              >
                <span className="min-w-0 flex-1 flex flex-col gap-0.5">
                  <span className="flex items-center gap-1.5 min-w-0 flex-wrap">
                    <span
                      className="truncate text-[12.5px] font-bold"
                      style={{ color: styles.text }}
                    >
                      {entry.name !== "" && entry.name !== entry.id ? entry.name : entry.id}
                    </span>
                    {free ? (
                      <span
                        className="shrink-0 px-1.5 py-0.5 rounded-full text-[10px] font-bold"
                        style={{ background: withAlpha("#22c55e", 0.12), color: "#22c55e" }}
                      >
                        FREE
                      </span>
                    ) : meta ? (
                      <span
                        className="shrink-0 px-1.5 py-0.5 rounded-full text-[10px] font-bold"
                        style={{ background: styles.subtle, color: styles.textTertiary }}
                      >
                        PAID
                      </span>
                    ) : null}
                    {alreadyAdded ? (
                      <span
                        className="shrink-0 px-1.5 py-0.5 rounded-full text-[10px] font-bold"
                        style={{ background: withAlpha("#22c55e", 0.12), color: "#22c55e" }}
                      >
                        ADDED
                      </span>
                    ) : (
                      <span
                        className="shrink-0 text-[10px] font-bold"
                        style={{ color: styles.textTertiary }}
                      >
                        CONFIGURE →
                      </span>
                    )}
                  </span>
                  <span className="flex items-center gap-2 min-w-0 flex-wrap">
                    <span className="truncate font-mono text-[10px]" style={{ color: styles.textTertiary }}>
                      {entry.id}
                    </span>
                    {meta && (
                      <span className="shrink-0 font-mono text-[10px]" style={{ color: styles.textTertiary }}>
                        {formatPricingSummary(meta) ?? "pricing unknown"}
                        {meta.contextWindow > 0 ? ` · ${formatContextWindow(meta.contextWindow)}` : ""}
                      </span>
                    )}
                  </span>
                </span>
              </button>
            );
          })}
          {rows.length === 0 && catalog.entries.length > 0 && (
            <div className="px-2 py-4 text-[11.5px]" style={{ color: styles.textTertiary }}>
              {/* ROUND-60: honest about BOTH filters — the free-only scope or
                  the search text may each have emptied the list. */}
              {freeOnly
                ? "No free models match — switch to “All models” or refine the search."
                : `No catalog model matches “${query.trim()}” — add one by id below.`}
            </div>
          )}
        </div>

        {/* footer: manual add-by-id (also rides the configure flow — the
            ROUND-87 contract: no add without configuration). */}
        <div
          className="shrink-0 border-t px-5 py-3.5 flex items-center gap-2"
          style={{ borderColor: styles.border, background: withAlpha(styles.accent, 0.02) }}
        >
          <input
            value={manualId}
            onChange={(e) => setManualId(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && manualId.trim()) onPick(prefillFor(manualId.trim()));
            }}
            placeholder="…or enter a model id not in the list"
            aria-label="Model id"
            className="h-10 flex-1 min-w-0 rounded-[14px] border-[1.5px] px-3.5 font-mono text-[12px] outline-none"
            style={inputStyle}
          />
          <button
            onClick={() => onPick(prefillFor(manualId.trim()))}
            disabled={!manualId.trim()}
            className="h-10 px-4 rounded-full text-[12px] font-bold disabled:opacity-50 shrink-0"
            style={{ background: styles.accent, color: styles.accentText }}
          >
            Configure & add
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── ROUND-50 (R50-d): the per-model configuration dialog ─────────────────── */

/** ROUND-87 (R87): the catalog prefill an ADD-mode dialog opens with — the
 * fields the served catalog knows (pricing, context window, display name
 * + the input modality bits), so the configure-before-add flow starts
 * from the truth instead of blank inputs. */
export interface ModelAddPrefill {
  modelId: string;
  displayName?: string;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  inputPricePerMtok?: number | null;
  inputPriceCachedPerMtok?: number | null;
  outputPricePerMtok?: number | null;
  supportsVision?: boolean;
}

/** Draft state for the config dialog — numerics live as STRINGS so an empty
 * input can mean "unknown" (null) rather than 0. */
interface ModelConfigDraft {
  modelId: string;
  displayName: string;
  sizeLabel: string;
  contextWindow: string;
  maxOutputTokens: string;
  inputPrice: string;
  outputPrice: string;
  cachePrice: string;
  // ROUND-62 (R62-2b): the vision flag (image INPUT — one of the input
  // capability chips in R87's dialog).
  supportsVision: boolean;
  // ROUND-82 (R82): the tri-state capability flags — null = unknown, false
  // = explicitly off, true = explicitly on. The R87 dialog renders them as
  // the INPUT (video/audio/pdf) and OUTPUT (text/image/video/audio) chips.
  supportsAudio: boolean | null;
  supportsVideo: boolean | null;
  supportsPdf: boolean | null;
  supportsTextOutput: boolean | null;
  supportsImageOutput: boolean | null;
  supportsVideoOutput: boolean | null;
  supportsAudioOutput: boolean | null;
  hidden: boolean;
}

function draftFromModel(model: ProviderModelConfig): ModelConfigDraft {
  const num = (v: number | null): string => (v === null ? "" : String(v));
  return {
    modelId: model.modelId,
    displayName: model.displayName || "",
    sizeLabel: model.sizeLabel ?? "",
    contextWindow: num(model.contextWindow),
    maxOutputTokens: num(model.maxOutputTokens),
    inputPrice: num(model.inputPricePerMtok),
    outputPrice: num(model.outputPricePerMtok),
    cachePrice: num(model.inputPriceCachedPerMtok),
    supportsVision: model.supportsVision,
    supportsAudio: model.supportsAudio,
    supportsVideo: model.supportsVideo,
    supportsPdf: model.supportsPdf,
    // Unknown text output renders ON (the chat-completions default).
    supportsTextOutput: model.supportsTextOutput === null ? true : model.supportsTextOutput,
    supportsImageOutput: model.supportsImageOutput,
    supportsVideoOutput: model.supportsVideoOutput,
    supportsAudioOutput: model.supportsAudioOutput,
    hidden: model.hidden,
  };
}

function draftFromPrefill(prefill: ModelAddPrefill): ModelConfigDraft {
  const num = (v: number | null | undefined): string => (v === null || v === undefined ? "" : String(v));
  return {
    modelId: prefill.modelId,
    displayName: prefill.displayName ?? "",
    sizeLabel: "",
    contextWindow: num(prefill.contextWindow),
    maxOutputTokens: num(prefill.maxOutputTokens),
    inputPrice: num(prefill.inputPricePerMtok),
    outputPrice: num(prefill.outputPricePerMtok),
    cachePrice: num(prefill.inputPriceCachedPerMtok),
    supportsVision: prefill.supportsVision ?? false,
    supportsAudio: null,
    supportsVideo: null,
    supportsPdf: null,
    // Text output defaults ON (the chat-completions contract).
    supportsTextOutput: true,
    supportsImageOutput: null,
    supportsVideoOutput: null,
    supportsAudioOutput: null,
    hidden: false,
  };
}

/** ROUND-87 (R87, owner: "the option for selecting the models … configure
 * which kinds of inputs this model accepts, like whether it accepts text
 * (all the models accept text), and configure whether it accepts images,
 * videos, and PDFs. The user can select those options on or off, not just
 * in the toggle format but in a cleaner way"): the CAPABILITY CHIP — a
 * clean on/off pill (accent-filled when on, bordered when off). Module
 * level, NOT inside the dialog — a component defined in render remounts
 * its subtree on every keystroke (the classic anti-pattern). */
function CapChip({
  label,
  on,
  onClick,
  locked = false,
  title,
  testId,
}: {
  label: string;
  on: boolean;
  onClick?: () => void;
  locked?: boolean;
  title: string;
  testId: string;
}) {
  const styles = useThemeStyles();
  return (
    <button
      type="button"
      onClick={locked ? undefined : onClick}
      aria-pressed={on}
      disabled={locked}
      title={title}
      data-testid={testId}
      className="h-8 px-3.5 rounded-full text-[11.5px] font-bold border-[1.5px] transition-all shrink-0 disabled:cursor-default"
      style={{
        borderColor: on ? styles.accent : styles.border,
        background: on ? styles.accent : "transparent",
        color: on ? styles.accentText : styles.textTertiary,
        opacity: locked ? 0.85 : 1,
      }}
    >
      {label}
    </button>
  );
}

function ModelConfigDialog({
  providerId,
  model,
  prefill,
  onClose,
  onSaved,
}: {
  providerId: string;
  /** EDIT mode: the stored row being configured (null in add mode). */
  model: ProviderModelConfig | null;
  /** ROUND-87 (R87) ADD mode: the catalog prefill (clicking a model in the
   * picker opens this dialog INSTEAD of adding directly — the owner: "It
   * should give the user the option to set them up"). */
  prefill: ModelAddPrefill | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const styles = useThemeStyles();
  const addMode = model === null && prefill !== null;
  const [draft, setDraft] = useState<ModelConfigDraft>(() =>
    model !== null ? draftFromModel(model) : draftFromPrefill(prefill ?? { modelId: "" }),
  );
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof ModelConfigDraft>(key: K, value: ModelConfigDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  // ADD mode: POST the upsert (configuring BEFORE the row exists); EDIT
  // mode: PATCH the stored row. Both ride the same parsed draft.
  const save = useMutation({
    mutationFn: (payload: ProviderModelConfigPatch) =>
      addMode
        ? upsertProviderModelConfig(providerId, {
            modelId: draft.modelId.trim(),
            ...payload,
          })
        : updateProviderModelConfig((model as ProviderModelConfig).id, payload),
    onSuccess: onSaved,
    onError: (err: Error) => setError(err.message),
  });

  const submit = () => {
    if (addMode && draft.modelId.trim() === "") {
      setError("Model id is required.");
      return;
    }
    // Parse every numeric: "" → null (unknown), junk → inline error naming
    // the field (the server 400s the same shapes — R50-d contract).
    type NumericDraftKey =
      | "contextWindow"
      | "maxOutputTokens"
      | "inputPrice"
      | "outputPrice"
      | "cachePrice";
    const fields: Array<[NumericDraftKey, string]> = [
      ["contextWindow", "Context window"],
      ["maxOutputTokens", "Max output tokens"],
      ["inputPrice", "Input price"],
      ["outputPrice", "Output price"],
      ["cachePrice", "Cache read price"],
    ];
    const parsed = {} as Record<NumericDraftKey, number | null>;
    for (const [key, label] of fields) {
      const value = parseNumericField(draft[key]);
      if (value === "invalid") {
        setError(`${label} must be a number ≥ 0 (or empty for unknown).`);
        return;
      }
      parsed[key] = value;
    }
    setError(null);
    save.mutate({
      displayName: draft.displayName.trim() || draft.modelId.trim(),
      sizeLabel: draft.sizeLabel.trim() === "" ? null : draft.sizeLabel.trim(),
      contextWindow: parsed.contextWindow,
      maxOutputTokens: parsed.maxOutputTokens,
      inputPricePerMtok: parsed.inputPrice,
      outputPricePerMtok: parsed.outputPrice,
      inputPriceCachedPerMtok: parsed.cachePrice,
      // ROUND-87 (R87): the input/output capability chips. Reasoning and
      // tool use are NOT sent — the app DETECTS those (the owner's
      // directive); absent keeps the stored/backend-prefilled values.
      supportsVision: draft.supportsVision,
      supportsAudio: draft.supportsAudio,
      supportsVideo: draft.supportsVideo,
      supportsPdf: draft.supportsPdf,
      supportsTextOutput: draft.supportsTextOutput,
      supportsImageOutput: draft.supportsImageOutput,
      supportsVideoOutput: draft.supportsVideoOutput,
      supportsAudioOutput: draft.supportsAudioOutput,
      hidden: draft.hidden,
    });
  };

  const inputStyle = {
    background: styles.bg,
    borderColor: styles.border,
    color: styles.text,
  } as const;

  const preview = formatPricingSummary({
    inputPricePerMtok: parseNumericField(draft.inputPrice) === "invalid" ? null : (parseNumericField(draft.inputPrice) as number | null),
    outputPricePerMtok: parseNumericField(draft.outputPrice) === "invalid" ? null : (parseNumericField(draft.outputPrice) as number | null),
    inputPriceCachedPerMtok: parseNumericField(draft.cachePrice) === "invalid" ? null : (parseNumericField(draft.cachePrice) as number | null),
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: "rgba(0,0,0,0.35)", backdropFilter: "blur(4px)" }}
      role="dialog"
      aria-modal="true"
      aria-label={addMode ? "Add model" : "Configure model"}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-full max-w-[680px] max-h-[86vh] overflow-y-auto auto-scroll rounded-[20px] border-[1.5px] p-5 flex flex-col gap-4"
        style={{ background: styles.card, borderColor: styles.border, boxShadow: styles.bentoShadow }}
      >
        {/* header — ROUND-87 (R87): ADD vs CONFIGURE + the provider chip
            (the send wire's actual routing target). */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[15px] font-black" style={{ color: styles.text }}>
            {addMode ? "Add model" : "Configure model"}
          </span>
          <span
            className="px-1.5 py-0.5 rounded-full font-mono text-[10px] font-bold"
            style={{ background: styles.subtle, color: styles.textTertiary }}
            title="The provider that serves this model (the send wire routes here since R82)"
          >
            {providerId}
          </span>
          <span className="flex-1" />
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-7 h-7 grid place-items-center rounded-[8px]"
            style={{ color: styles.textTertiary }}
          >
            <X size={14} />
          </button>
        </div>

        {/* ROUND-82: the two-column body — Identity + Capabilities (left)
            and Sizing + Pricing (right) at ≥560px; single column below
            (small windows / narrow settings panes). */}
        <div className="grid grid-cols-1 min-[560px]:grid-cols-2 gap-4 items-start">
          {/* ── LEFT: Identity + Capabilities ── */}
          <div className="flex flex-col gap-4 min-w-0">
            <div className="flex flex-col gap-2">
              <SectionLabel>Identity</SectionLabel>
              <div>
                <label className="mb-1.5 block text-[11px] font-bold" style={{ color: styles.textSecondary }}>
                  Display name
                </label>
                <input
                  value={draft.displayName}
                  onChange={(e) => set("displayName", e.target.value)}
                  placeholder={draft.modelId || "the friendly name shown in pickers"}
                  aria-label="Display name"
                  className="h-10 w-full rounded-[10px] border-[1.5px] px-3 text-[13px] outline-none"
                  style={inputStyle}
                />
              </div>
              <div>
                <label className="mb-1.5 block text-[11px] font-bold" style={{ color: styles.textSecondary }}>
                  Model id
                </label>
                {addMode ? (
                  <input
                    value={draft.modelId}
                    onChange={(e) => set("modelId", e.target.value)}
                    placeholder="provider/model-name"
                    aria-label="Model id"
                    className="h-10 w-full rounded-[10px] border-[1.5px] px-3 font-mono text-[11.5px] outline-none"
                    style={inputStyle}
                    data-testid="model-config-id-input"
                  />
                ) : (
                  <p
                    className="h-10 flex items-center w-full rounded-[10px] border-[1.5px] px-3 font-mono text-[11px] break-all overflow-hidden"
                    style={{ borderColor: styles.border, background: styles.subtle, color: styles.textTertiary }}
                    aria-label="Model id (read-only)"
                  >
                    {draft.modelId}
                  </p>
                )}
              </div>
              {/* ROUND-87 (R87): the SIZE label — a human-facing parameter
                  size ("70B", "405B MoE") for the detail row. */}
              <div>
                <label className="mb-1.5 block text-[11px] font-bold" style={{ color: styles.textSecondary }}>
                  Size <span className="font-normal" style={{ color: styles.textTertiary }}>(e.g. 70B — display only)</span>
                </label>
                <input
                  value={draft.sizeLabel}
                  onChange={(e) => set("sizeLabel", e.target.value)}
                  placeholder="unknown"
                  aria-label="Size label"
                  className="h-10 w-full rounded-[10px] border-[1.5px] px-3 text-[13px] outline-none"
                  style={inputStyle}
                  data-testid="model-config-size-input"
                />
              </div>
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <span className="block text-[12px] font-bold" style={{ color: styles.textSecondary }}>
                    Hide from chat picker
                  </span>
                  <span className="block text-[10.5px]" style={{ color: styles.textTertiary }}>
                    Kept here in Settings, but not offered in the chat model selector.
                  </span>
                </div>
                <div
                  role="group"
                  aria-label="Hide from chat picker"
                  className="flex items-center rounded-[10px] border-[1.5px] overflow-hidden shrink-0"
                  style={{ borderColor: styles.border }}
                >
                  {([
                    { id: "on", label: "On", active: draft.hidden, pick: () => set("hidden", true) },
                    { id: "off", label: "Off", active: !draft.hidden, pick: () => set("hidden", false) },
                  ] as const).map((seg) => (
                    <button
                      key={seg.id}
                      onClick={seg.pick}
                      aria-pressed={seg.active}
                      className="h-7 px-3 text-[11px] font-bold transition-colors"
                      style={{
                        background: seg.active ? withAlpha(styles.accent, 0.12) : "transparent",
                        color: seg.active ? styles.accent : styles.textTertiary,
                      }}
                    >
                      {seg.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* ROUND-87 (R87, owner: "configure which kinds of inputs this
                model accepts … and configure which kinds of outputs this
                model can provide"): the INPUT and OUTPUT capability CHIP
                GROUPS — clean on/off pills (text input is locked ON — all
                models accept text; text output defaults ON but can be
                turned off). Reasoning + tool use are deliberately ABSENT:
                the app detects those at runtime. */}
            <div className="flex flex-col gap-3">
              <SectionLabel>Input capabilities</SectionLabel>
              <div className="flex flex-wrap gap-1.5">
                <CapChip label="Text" on locked title="Every chat model accepts text input" testId="model-cap-text-in" />
                <CapChip
                  label="Images"
                  on={draft.supportsVision}
                  onClick={() => set("supportsVision", !draft.supportsVision)}
                  title="Accepts image inputs — gates the main-mode vision relay"
                  testId="model-cap-images-in"
                />
                <CapChip
                  label="Video"
                  on={draft.supportsVideo === true}
                  onClick={() => set("supportsVideo", draft.supportsVideo === true ? false : true)}
                  title="Accepts video inputs"
                  testId="model-cap-video-in"
                />
                <CapChip
                  label="PDF"
                  on={draft.supportsPdf === true}
                  onClick={() => set("supportsPdf", draft.supportsPdf === true ? false : true)}
                  title="Accepts PDF documents"
                  testId="model-cap-pdf-in"
                />
                <CapChip
                  label="Audio"
                  on={draft.supportsAudio === true}
                  onClick={() => set("supportsAudio", draft.supportsAudio === true ? false : true)}
                  title="Accepts audio inputs"
                  testId="model-cap-audio-in"
                />
              </div>
              <SectionLabel>Output capabilities</SectionLabel>
              <div className="flex flex-wrap gap-1.5">
                <CapChip
                  label="Text"
                  on={draft.supportsTextOutput !== false}
                  onClick={() => set("supportsTextOutput", draft.supportsTextOutput !== false ? false : true)}
                  title="Produces text output — on by default for chat models"
                  testId="model-cap-text-out"
                />
                <CapChip
                  label="Images"
                  on={draft.supportsImageOutput === true}
                  onClick={() => set("supportsImageOutput", draft.supportsImageOutput === true ? false : true)}
                  title="Produces image output"
                  testId="model-cap-images-out"
                />
                <CapChip
                  label="Video"
                  on={draft.supportsVideoOutput === true}
                  onClick={() => set("supportsVideoOutput", draft.supportsVideoOutput === true ? false : true)}
                  title="Produces video output"
                  testId="model-cap-video-out"
                />
                <CapChip
                  label="Audio"
                  on={draft.supportsAudioOutput === true}
                  onClick={() => set("supportsAudioOutput", draft.supportsAudioOutput === true ? false : true)}
                  title="Produces audio output"
                  testId="model-cap-audio-out"
                />
              </div>
              <p className="text-[10.5px]" style={{ color: styles.textTertiary }}>
                Reasoning and tool use are detected automatically — never configured here.
              </p>
            </div>
          </div>

          {/* ── RIGHT: Sizing + Pricing ── */}
          <div className="flex flex-col gap-4 min-w-0">
            {/* sizing */}
            <div className="flex flex-col gap-2">
              <SectionLabel>Sizing</SectionLabel>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="mb-1 block text-[10.5px] font-bold" style={{ color: styles.textTertiary }}>
                    Context window (tokens)
                  </label>
                  <input
                    value={draft.contextWindow}
                    onChange={(e) => set("contextWindow", e.target.value)}
                    placeholder="unknown"
                    aria-label="Context window (tokens)"
                    className="h-10 w-full rounded-[10px] border-[1.5px] px-3 font-mono text-[12px] outline-none"
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[10.5px] font-bold" style={{ color: styles.textTertiary }}>
                    Max output tokens
                  </label>
                  <input
                    value={draft.maxOutputTokens}
                    onChange={(e) => set("maxOutputTokens", e.target.value)}
                    placeholder="unknown"
                    aria-label="Max output tokens"
                    className="h-10 w-full rounded-[10px] border-[1.5px] px-3 font-mono text-[12px] outline-none"
                    style={inputStyle}
                  />
                </div>
              </div>
            </div>

            {/* pricing */}
            <div className="flex flex-col gap-2">
              <SectionLabel>Pricing — USD per 1M tokens</SectionLabel>
              <div className="grid grid-cols-1 gap-2">
                <div>
                  <label className="mb-1 block text-[10.5px] font-bold" style={{ color: styles.textTertiary }}>
                    Input price
                  </label>
                  <input
                    value={draft.inputPrice}
                    onChange={(e) => set("inputPrice", e.target.value)}
                    inputMode="decimal"
                    placeholder="unknown"
                    aria-label="Input price ($ per 1M tokens)"
                    className="h-10 w-full rounded-[10px] border-[1.5px] px-3 font-mono text-[12px] outline-none"
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[10.5px] font-bold" style={{ color: styles.textTertiary }}>
                    Output price
                  </label>
                  <input
                    value={draft.outputPrice}
                    onChange={(e) => set("outputPrice", e.target.value)}
                    inputMode="decimal"
                    placeholder="unknown"
                    aria-label="Output price ($ per 1M tokens)"
                    className="h-10 w-full rounded-[10px] border-[1.5px] px-3 font-mono text-[12px] outline-none"
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[10.5px] font-bold" style={{ color: styles.textTertiary }}>
                    Cache read price
                  </label>
                  <input
                    value={draft.cachePrice}
                    onChange={(e) => set("cachePrice", e.target.value)}
                    inputMode="decimal"
                    placeholder="unknown"
                    aria-label="Cache read price ($ per 1M tokens)"
                    className="h-10 w-full rounded-[10px] border-[1.5px] px-3 font-mono text-[12px] outline-none"
                    style={inputStyle}
                  />
                </div>
              </div>
              <p className="text-[10.5px]" style={{ color: styles.textTertiary }}>
                Each field is US dollars per 1 million tokens — leave empty for unknown (an empty price is never treated as $0).
              </p>
            </div>

            {/* live preview */}
            <div
              className="rounded-[10px] px-3 py-2 font-mono text-[10.5px]"
              style={{ background: styles.subtle, color: styles.textTertiary }}
            >
              {preview ?? "pricing not set"}
              {parseNumericField(draft.contextWindow) !== null &&
                parseNumericField(draft.contextWindow) !== "invalid" &&
                ` · ${formatContextWindow(parseNumericField(draft.contextWindow) as number)}`}
            </div>
          </div>
        </div>

        {error && (
          <p role="alert" className="text-[11.5px]" style={{ color: "#ef4444" }}>
            {error}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={onClose}
            className="h-10 px-4 rounded-[10px] border-[1.5px] text-[12px] font-bold"
            style={{ borderColor: styles.border, color: styles.textSecondary }}
          >
            Cancel
          </button>
          {model !== null && <ModelTestButton model={model} />}
          <span className="flex-1" />
          <button
            onClick={submit}
            disabled={save.isPending}
            className="h-10 px-5 rounded-full text-[12.5px] font-bold disabled:opacity-50"
            style={{ background: styles.accent, color: styles.accentText }}
            data-testid="model-config-save"
          >
            {save.isPending ? "Saving…" : addMode ? "Add model" : "Save configuration"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── ROUND-36 (ADR-0022): the per-provider API key pool ───────────────────── */

/** Exported for the ROUND-47 (R47-c1) regression test — the slot-collision
 * fix lives in the add-slot mutation below.
 *
 * ROUND-50 (R50-d): `hideLabel` — the detail pane now renders this section
 * inside its own labeled card ("API KEY POOL"); the built-in field label is
 * suppressed there to avoid a doubled title (default keeps the old look for
 * any other caller). */
export function KeyPoolSection({ providerId, hideLabel = false }: { providerId: string; hideLabel?: boolean }) {
  const styles = useThemeStyles();
  const queryClient = useQueryClient();
  const resetAfter = useTimeoutClear();
  const [newKey, setNewKey] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // ROUND-58 (R58-d): per-row revealed pool values — masked by default; the
  // reveal fetch is ONE call per provider (the route returns every slot) and
  // its result is CACHED here, while the SHOWING state is a per-row toggle.
  // Never auto-fetched on mount.
  const [revealedValues, setRevealedValues] = useState<Record<number, string>>({});
  const [revealedRows, setRevealedRows] = useState<Set<number>>(new Set());
  const [revealLoading, setRevealLoading] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);

  // Same query key the detail pane's test-key selector uses — one cache.
  const poolQuery = useQuery({
    queryKey: ["key-pool", providerId],
    queryFn: () => fetchKeyPool(providerId),
  });
  const pool = poolQuery.data ?? [];
  const slots = pool.filter((k) => k.slot > 0);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["key-pool", providerId] });
    // ROUND-62 (R62-2b): the fan-out form — pool changes flip nothing the
    // session picker renders, but one cache entry per resource keeps the
    // pages from diverging.
    invalidateProvidersEverywhere(queryClient);
  };

  // ROUND-58 (R58-d) correction: pool mutations (add/remove) invalidate the
  // cached reveal map — a value fetched BEFORE the mutation could otherwise
  // linger as a STALE reveal (removed-and-re-added slots with a new key).
  // Rows snap back to masked; the next reveal re-fetches (one call).
  const resetRevealCache = () => {
    setRevealedValues({});
    setRevealedRows(new Set());
  };

  const addSlot = useMutation({
    mutationFn: async (value: string) => {
      // ROUND-47 (R47-c1) FIX: the old `slots.length + 2` collided whenever
      // the pool had a gap (slots 2 & 4 held → the next add OVERWROTE slot
      // 4's key). The next FREE slot 2..31 — exactly like SubAgentsTab.
      const slot = nextFreeSlot(slots.filter((k) => k.hasKey).map((k) => k.slot));
      if (slot < 0) throw new Error("the key pool is full (slots 2–31)");
      if (isTauri()) {
        // NOTE (pre-existing, unchanged R47-c1 behavior): the shell's
        // store_provider_key command has no slot parameter — it stores the
        // PRIMARY key. Slot-aware Tauri pool keys need a shell change
        // (src-tauri is out of scope this round; flagged in the handoff).
        const { storeProviderKey: storeViaShell } = await import("../onboarding/providers-api");
        const ok = await storeViaShell(providerId, value);
        if (!ok) throw new Error("the shell refused the key store request");
        return;
      }
      await setKeyPoolSlot(providerId, slot, value);
    },
    onSuccess: () => {
      setNewKey("");
      setMsg("Slot added.");
      resetAfter(() => setMsg(null), 1500);
      resetRevealCache();
      invalidate();
    },
    onError: (err: Error) => setMsg(err.message),
  });

  const removeSlot = useMutation({
    mutationFn: (slot: number) => removeKeyPoolSlot(providerId, slot),
    onSuccess: () => {
      resetRevealCache();
      invalidate();
    },
    onError: (err: Error) => setMsg(err.message),
  });

  // ROUND-58 (R58-d): reveal one row's FULL value. The reveal route returns
  // every held slot in ONE response — the FIRST reveal fetches it and caches
  // the map (zero extra calls afterwards); each row's showing state is its
  // own toggle. Never called on mount.
  const revealSlot = async (slot: number) => {
    if (revealedRows.has(slot)) {
      // Toggle off — mask again.
      setRevealedRows((prev) => {
        const next = new Set(prev);
        next.delete(slot);
        return next;
      });
      return;
    }
    // The up-to-date slot→value map this call resolves against (the freshly
    // fetched one on the first reveal; the cached state afterwards — never
    // the stale closure value across the await).
    let map = revealedValues;
    // Re-fetch when the cache is empty OR stale for THIS slot: the masked
    // listing says the slot HOLDS a key but the cached reveal predates it
    // (a slot added after the first reveal — cache-miss, not "no key").
    const listingSaysHeld = slots.find((k) => k.slot === slot)?.hasKey === true;
    if (Object.keys(map).length === 0 || (map[slot] === undefined && listingSaysHeld)) {
      // First reveal this mount (or a cache-miss) — one fetch fills it.
      setRevealError(null);
      setRevealLoading(true);
      try {
        const keys = await revealProviderKeys(providerId);
        map = {};
        for (const k of keys) map[k.slot] = k.value;
        setRevealedValues(map);
      } catch (err) {
        setRevealError(err instanceof Error ? err.message : String(err));
        return;
      } finally {
        setRevealLoading(false);
      }
    }
    if (map[slot] === undefined) {
      // Fetched/cached, but this slot holds no key — honest.
      setRevealError(`No key stored in slot ${slot}.`);
      return;
    }
    setRevealedRows((prev) => new Set(prev).add(slot));
  };

  const copySlotValue = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setMsg("Key copied to clipboard.");
      resetAfter(() => setMsg(null), 1500);
    } catch {
      setMsg("Copy failed — the clipboard is unavailable in this context.");
      resetAfter(() => setMsg(null), 1500);
    }
  };

  return (
    <div>
      {!hideLabel && (
        <label className="mb-1.5 block text-[11px] font-bold" style={{ color: styles.textSecondary }}>
          API key pool <span style={{ color: styles.textTertiary }}>— dedicated keys for sub-agents (primary stays free)</span>
        </label>
      )}
      <div className="rounded-[10px] border-[1.5px] overflow-hidden" style={{ borderColor: styles.border }}>
        {slots.length === 0 && (
          <div className="px-3 py-2.5 text-[11px]" style={{ color: styles.textTertiary }}>
            No pool slots — sub-agents share the primary key (rate-limited by the per-key setting).
          </div>
        )}
        {slots.map((k) => {
          const revealed = revealedRows.has(k.slot) ? revealedValues[k.slot] : undefined;
          return (
            <div key={k.slot} data-pool-slot={k.slot} className="flex items-center gap-2 px-3 py-2 border-b last:border-b-0" style={{ borderColor: styles.borderSubtle }}>
              <span className="text-[11px] font-mono font-bold shrink-0" style={{ color: styles.textSecondary }}>
                SLOT {k.slot}
              </span>
              {revealed !== undefined ? (
                // ROUND-58 (R58-d): the revealed full value — mono, break-all,
                // with a copy affordance. Masked again via the eye button.
                <span
                  className="font-mono text-[11px] flex-1 min-w-0 break-all"
                  style={{ color: styles.textSecondary }}
                  data-revealed-value
                >
                  {revealed}
                </span>
              ) : (
                <span className="font-mono text-[11px] flex-1 min-w-0 truncate" style={{ color: styles.textTertiary }}>
                  {k.masked ?? "—"}
                </span>
              )}
              {/* ROUND-58 (R58-d): the reveal eye — only rows that HOLD a key
                  get it (a keyless row has nothing to reveal). */}
              {k.hasKey && (
                <button
                  onClick={() => void revealSlot(k.slot)}
                  // ROUND-58 (R58-d): disabled during ANY reveal fetch (the
                  // first reveal AND a cache-miss re-fetch) — no double-click
                  // can fire two concurrent fetches.
                  disabled={revealLoading}
                  aria-label={revealed !== undefined ? `Hide slot ${k.slot} key` : `Reveal slot ${k.slot} key`}
                  title={revealed !== undefined ? "Mask again" : "Show the full key"}
                  className="w-6 h-6 grid place-items-center rounded-md shrink-0 disabled:opacity-50"
                  style={{ color: styles.textTertiary }}
                >
                  {revealLoading ? (
                    <RefreshCw size={11} className="animate-spin" />
                  ) : revealed !== undefined ? (
                    <EyeOff size={11} />
                  ) : (
                    <Eye size={11} />
                  )}
                </button>
              )}
              {revealed !== undefined && (
                <button
                  onClick={() => void copySlotValue(revealed)}
                  aria-label={`Copy slot ${k.slot} key`}
                  title="Copy the full key"
                  className="w-6 h-6 grid place-items-center rounded-md shrink-0"
                  style={{ color: styles.textTertiary }}
                >
                  <Copy size={11} />
                </button>
              )}
              <button
                onClick={() => {
                  if (window.confirm(`Remove pool slot ${k.slot}?`)) removeSlot.mutate(k.slot);
                }}
                aria-label={`Remove slot ${k.slot}`}
                title="Remove slot"
                className="w-6 h-6 grid place-items-center rounded-md shrink-0"
                style={{ color: styles.textTertiary }}
                onMouseEnter={(e) => (e.currentTarget.style.background = withAlpha("#ef4444", 0.12))}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                <Trash2 size={11} />
              </button>
            </div>
          );
        })}
        {/* Add slot row */}
        <div className="flex items-center gap-2 px-3 py-2 border-t" style={{ borderColor: styles.borderSubtle, background: withAlpha(styles.accent, 0.03) }}>
          <div className="relative flex-1 min-w-0">
            <input
              type={showNew ? "text" : "password"}
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder="new pool key (sk-…)"
              aria-label="New pool key"
              className="h-8 w-full rounded-[8px] border-[1.5px] px-2.5 pr-8 font-mono text-[11px] outline-none"
              style={{ background: styles.bg, borderColor: styles.border, color: styles.text }}
            />
            <button
              onClick={() => setShowNew((v) => !v)}
              aria-label={showNew ? "Hide key" : "Show key"}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 w-5 h-5 grid place-items-center rounded-md"
              style={{ color: styles.textTertiary }}
            >
              {showNew ? <EyeOff size={11} /> : <Eye size={11} />}
            </button>
          </div>
          <button
            onClick={() => newKey.trim() && addSlot.mutate(newKey.trim())}
            disabled={!newKey.trim() || addSlot.isPending}
            className="h-8 px-3 rounded-[8px] text-[11px] font-bold flex items-center gap-1 disabled:opacity-50"
            style={{ background: withAlpha(styles.accent, 0.12), color: styles.accent }}
          >
            <Plus size={11} strokeWidth={2.5} /> {addSlot.isPending ? "Adding…" : "Add slot"}
          </button>
        </div>
      </div>
      {msg && <p className="mt-1.5 text-[11px]" style={{ color: addSlot.isError || removeSlot.isError ? "#ef4444" : "#22c55e" }}>{msg}</p>}
      {revealError && (
        <p className="mt-1.5 text-[11px] break-all" style={{ color: "#ef4444" }} role="alert">
          {revealError}
        </p>
      )}
      <p className="mt-1 text-[10.5px]" style={{ color: styles.textTertiary }}>
        Sub-agents prefer pool slots (least-loaded first) so the primary key serves your main chats.
      </p>
      {/* ROUND-47 (R47-c1): browser-dev honesty — pool keys share the
          sidecar's in-memory keyring (same ephemerality as the primary). */}
      {!isTauri() && (
        <p className="mt-1 text-[10.5px]" style={{ color: styles.textTertiary, opacity: 0.75 }}>
          {EPHEMERAL_KEY_NOTE}
        </p>
      )}
    </div>
  );
}
