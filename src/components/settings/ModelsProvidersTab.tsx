import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
  "Browser-dev keys live in server memory only — they reset on restart; use credentials.txt (launcher) for durable keys.";

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

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: ["settings-providers"] });

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
        <div
          ref={listScrollRef}
          className="flex-1 min-h-0 overflow-y-auto auto-scroll p-1.5"
        >
          {/* ROUND-59 (R59-C): empty means NO CONFIGURED rows — keyless
              presets don't count as providers here anymore. */}
          {configuredProviders.length === 0 && (
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

      {/* Add Provider DIALOG (preset choice → fields) */}
      {adding && (
        <AddProviderDialog
          existingIds={new Set(providers.map((p) => p.id))}
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
      void queryClient.invalidateQueries({ queryKey: ["settings-providers"] });
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
      void queryClient.invalidateQueries({ queryKey: ["settings-provider-models"] });
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
  existingIds,
  onClose,
  onCreated,
}: {
  existingIds: Set<string>;
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

  const create = useMutation({
    mutationFn: async (): Promise<{ id: string; keyError?: string }> => {
      const isPreset = presetId !== null && presetId !== "custom";
      // ROUND-47 (R47-c1): the canonical api.ts fn — same wire shape the
      // dialog always sent (name / baseUrl / apiFormat / preset id; the key
      // NEVER rides in the create body — it goes to the dedicated key route
      // or the Tauri shell so no create/list envelope can leak it).
      const created = await createProvider({
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        apiFormat,
        // Presets re-claim their reserved id (resurrects a deleted built-in).
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
  const valid = name.trim().length > 0 && /^https?:\/\/.+/.test(baseUrl.trim());

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
                const alreadyAdded = p.id !== "custom" && existingIds.has(p.id);
                return (
                  <button
                    key={p.id}
                    onClick={() => !alreadyAdded && choosePreset(p.id)}
                    disabled={alreadyAdded}
                    className="h-12 px-4 rounded-[12px] border-[1.5px] flex items-center gap-3 text-left transition-colors disabled:opacity-55"
                    style={{ borderColor: styles.border, background: styles.bg, color: styles.text }}
                    onMouseEnter={(e) => {
                      if (!alreadyAdded) e.currentTarget.style.borderColor = withAlpha(styles.accent, 0.5);
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
                    {alreadyAdded ? (
                      <span
                        className="shrink-0 text-[10px] font-bold px-2 py-0.5 rounded-full"
                        style={{ background: withAlpha("#22c55e", 0.12), color: "#22c55e" }}
                      >
                        added
                      </span>
                    ) : (
                      <span className="shrink-0 text-[11px] font-bold" style={{ color: styles.accent }}>
                        Add →
                      </span>
                    )}
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
                onChange={(e) => setName(e.target.value)}
                placeholder="My Gateway"
                aria-label="Provider name"
                className="h-10 w-full rounded-[10px] border-[1.5px] px-3 text-[13px] outline-none"
                style={inputStyle}
              />
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

function ModelListSection({
  providerId,
  models,
  catalog,
  staticCatalog,
}: {
  providerId: string;
  models: ProviderModelConfig[];
  catalog: ProviderCatalogState;
  staticCatalog: CatalogModel[];
}) {
  const styles = useThemeStyles();
  const queryClient = useQueryClient();
  // ROUND-50 (R50-d): the "Add models" picker dialog + the per-model
  // configuration dialog (replaces the inline type-an-id row editor).
  const [pickerOpen, setPickerOpen] = useState(false);
  const [configuring, setConfiguring] = useState<ProviderModelConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ROUND-60 (R60-B): the list shows CONFIGURED (stored) rows ONLY — the
  // R58/R50 catalog→list merge is GONE (the owner: "By default none of the
  // models should be added there… By default there should not be the free
  // models or all models there at all. I should be able to manually add
  // the models and only after that they will be shown there"). The live
  // catalog feeds the "Add models" picker ALONE — catalogIds is [] by
  // design; the static catalog stays a param for the picker pre-fill.
  const merged = mergeCatalogIntoModels(models, [], staticCatalog);

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: ["settings-provider-models", providerId] });

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

      {merged.length === 0 ? (
        <div className="px-4 py-6 text-center text-[12px]" style={{ color: styles.textTertiary }}>
          No models yet — use “Add models” to pick from the provider's catalog.
        </div>
      ) : (
        <div>
          {merged.map((m) => (
            <div
              key={m.rowId ?? `cat:${m.modelId}`}
              className="flex items-center gap-3 px-4 py-2.5 border-b last:border-b-0"
              style={{ borderColor: styles.borderSubtle }}
            >
              {/* left: name + badges / id + pricing summary (R50-d) */}
              <div className="min-w-0 flex-1 flex flex-col gap-0.5">
                <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
                  <span
                    className="truncate text-[12.5px] font-semibold"
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
                  {m.supportsThinking && (
                    <span
                      className="shrink-0 px-1.5 py-0.5 rounded-full text-[10px] font-bold"
                      style={{ background: styles.subtle, color: styles.textTertiary }}
                      title="Supports thinking / reasoning output"
                    >
                      THINKING
                    </span>
                  )}
                  {m.hidden && (
                    <span
                      className="shrink-0 px-1.5 py-0.5 rounded-full text-[10px] font-bold"
                      style={{ background: styles.subtle, color: styles.textTertiary }}
                      title="Hidden from the chat model picker (still visible here)"
                    >
                      HIDDEN
                    </span>
                  )}
                  {/* ROUND-60 (R60-B): the "catalog" badge is gone with the
                      catalog→list merge — every row here is a STORED row. */}
                </div>
                <div className="flex items-center gap-2 min-w-0 flex-wrap">
                  <span
                    className="truncate font-mono text-[10px]"
                    style={{ color: styles.textTertiary }}
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
                  {/* ROUND-50 (R50-d): the full configuration dialog — pricing,
                      context window, max output, thinking, hidden. */}
                  <button
                    onClick={() => {
                      const row = models.find((row) => row.id === m.rowId);
                      if (row) setConfiguring(row);
                    }}
                    aria-label={`Configure model ${m.displayName || m.modelId}`}
                    title="Configure — pricing, context window, limits"
                    className="h-7 px-2 grid place-items-center rounded-[8px] shrink-0 text-[11px] font-bold"
                    style={{ color: styles.textSecondary }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = withAlpha(styles.accent, 0.1))}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    onClick={() => {
                      if (window.confirm(`Delete model "${m.displayName || m.modelId}"?`)) deleteModel.mutate(m.rowId!);
                    }}
                    aria-label={`Delete model ${m.displayName || m.modelId}`}
                    title="Delete"
                    className="w-7 h-7 grid place-items-center rounded-[8px] shrink-0"
                    style={{ color: styles.textTertiary }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = withAlpha("#ef4444", 0.12))}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ROUND-50 (R50-d): the catalog-driven picker + the per-model config
          dialog. Both invalidate THIS provider's models query on change. */}
      {pickerOpen && (
        <AddModelsDialog
          providerId={providerId}
          catalog={catalog}
          staticCatalog={staticCatalog}
          configuredIds={new Set(models.map((m) => m.modelId))}
          onClose={() => setPickerOpen(false)}
          onChanged={() => {
            invalidate();
            setError(null);
          }}
        />
      )}
      {configuring && (
        <ModelConfigDialog
          model={configuring}
          onClose={() => setConfiguring(null)}
          onSaved={() => {
            invalidate();
            setConfiguring(null);
          }}
        />
      )}
    </div>
  );
}

/* ── ROUND-50 (R50-d): the "Add models" catalog picker dialog ─────────────── */

function AddModelsDialog({
  providerId,
  catalog,
  staticCatalog,
  configuredIds,
  onClose,
  onChanged,
}: {
  providerId: string;
  catalog: ProviderCatalogState;
  staticCatalog: CatalogModel[];
  configuredIds: Set<string>;
  onClose: () => void;
  onChanged: () => void;
}) {
  const styles = useThemeStyles();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [manualId, setManualId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // ROUND-60 (R60-B): the Free only ↔ All models scope toggle — moved INTO
  // the picker from the models list header (the owner: "in the add model for
  // the open router, there should be an option to switch between free only
  // and all models properly"). It rides the SHARED persisted pref
  // (useSettingsStore.modelsFreeOnly — the round-43 design) so the chat
  // composer's model picker honors the same choice; free is the default.
  const modelsFreeOnly = useSettingsStore((s) => s.modelsFreeOnly);
  const setModelsFreeOnly = useSettingsStore((s) => s.setModelsFreeOnly);

  const staticById = useMemo(
    () => new Map(staticCatalog.map((m) => [m.modelId, m])),
    [staticCatalog],
  );

  const q = query.trim().toLowerCase();
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
      if (!modelsFreeOnly) return true;
      const meta = staticById.get(entry.id);
      return meta ? meta.free : isFreeModelEntry({ modelId: entry.id });
    })
    .slice(0, 300); // sanity cap — the live OpenRouter catalog is huge

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /** One upsert per selected model — known pricing/context is pre-filled
   * from the served catalog so the row lands fully configured. Failures are
   * collected (allSettled) and surfaced honestly; ONE invalidation after. */
  const addSelected = useMutation({
    mutationFn: async (): Promise<{ added: number; failed: number; firstError?: string }> => {
      const ids = [...selected];
      const results = await Promise.allSettled(
        ids.map((id) => {
          const meta = staticById.get(id);
          const entry = catalog.entries.find((e) => e.id === id);
          return upsertProviderModelConfig(providerId, {
            modelId: id,
            // Prefer the provider's OWN name; fall back to the catalog's.
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
                }
              : {}),
          });
        }),
      );
      const failures = results.filter(
        (r): r is PromiseRejectedResult => r.status === "rejected",
      );
      return {
        added: ids.length - failures.length,
        failed: failures.length,
        firstError:
          failures.length > 0
            ? failures[0].reason instanceof Error
              ? failures[0].reason.message
              : String(failures[0].reason)
            : undefined,
      };
    },
    onSuccess: ({ added, failed, firstError }) => {
      setSelected(new Set());
      onChanged();
      if (failed === 0) {
        onClose();
        return;
      }
      setError(
        `Added ${added}, failed ${failed} — ${firstError ?? "unknown error"}`,
      );
    },
    onError: (err: Error) => setError(err.message),
  });

  /** The manual path (owner: ids not in the catalog) — one upsert by id. */
  const addManual = useMutation({
    mutationFn: () =>
      upsertProviderModelConfig(providerId, { modelId: manualId.trim() }),
    onSuccess: (model) => {
      setManualId("");
      setNotice(`Added ${model.modelId}.`);
      setError(null);
      onChanged();
    },
    onError: (err: Error) => {
      setNotice(null);
      setError(err.message);
    },
  });

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
          Pick from this provider&apos;s live catalog — known pricing, context windows, and limits are
          pre-filled from the served catalog and stay editable after adding.
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
              className="h-9 w-full rounded-[10px] border-[1.5px] pl-8 pr-3 text-[12px] outline-none"
              style={inputStyle}
            />
          </div>
          {/* Same segmented visual language the rest of the app uses
              (SubAgentsTab / ModelSelector) — the toggle rides the shared
              persisted modelsFreeOnly pref. */}
          <div
            role="group"
            aria-label="Catalog filter"
            className="flex items-center rounded-[10px] border-[1.5px] overflow-hidden shrink-0"
            style={{ borderColor: styles.border }}
          >
            {([
              { id: "free", label: "Free only", active: modelsFreeOnly, pick: () => setModelsFreeOnly(true) },
              { id: "all", label: "All models", active: !modelsFreeOnly, pick: () => setModelsFreeOnly(false) },
            ] as const).map((seg) => (
              <button
                key={seg.id}
                onClick={seg.pick}
                aria-pressed={seg.active}
                data-testid={seg.id === "free" ? "picker-free-only-toggle" : "picker-all-models-toggle"}
                className="h-9 px-2.5 text-[11px] font-bold transition-colors whitespace-nowrap"
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

        {/* the catalog rows */}
        <div className="flex-1 min-h-0 overflow-y-auto auto-scroll px-3 pb-2">
          {catalog.isFetching && catalog.entries.length === 0 && (
            <div className="px-2 py-4 text-[11.5px] flex items-center gap-2" style={{ color: styles.textTertiary }}>
              <RefreshCw size={12} className="animate-spin" /> Fetching the provider catalog…
            </div>
          )}
          {!catalog.isFetching && catalog.entries.length === 0 && (
            <div className="px-2 py-4 text-[11.5px]" style={{ color: styles.textTertiary }}>
              {catalog.isError
                ? "The live catalog is unreachable for this provider — add models by id below."
                : "This provider serves no catalog — add models by id below."}
            </div>
          )}
          {rows.map((entry) => {
            const meta = staticById.get(entry.id);
            const alreadyAdded = configuredIds.has(entry.id);
            const isSelected = selected.has(entry.id);
            const free = meta ? meta.free : isFreeModelEntry({ modelId: entry.id });
            return (
              <label
                key={entry.id}
                className="flex items-center gap-3 px-2.5 py-2 rounded-[10px] cursor-pointer transition-colors"
                style={{
                  background: isSelected ? withAlpha(styles.accent, 0.07) : "transparent",
                  opacity: alreadyAdded ? 0.55 : 1,
                  cursor: alreadyAdded ? "default" : "pointer",
                }}
                title={entry.id}
              >
                <input
                  type="checkbox"
                  checked={alreadyAdded || isSelected}
                  disabled={alreadyAdded}
                  onChange={() => !alreadyAdded && toggle(entry.id)}
                  aria-label={`Select model ${entry.id}`}
                  className="w-4 h-4 shrink-0 cursor-pointer"
                  style={{ accentColor: styles.accent }}
                />
                <span className="min-w-0 flex-1 flex flex-col">
                  <span className="flex items-center gap-1.5 min-w-0 flex-wrap">
                    <span
                      className="truncate text-[12px] font-semibold"
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
                    {alreadyAdded && (
                      <span
                        className="shrink-0 px-1.5 py-0.5 rounded-full text-[10px] font-bold"
                        style={{ background: withAlpha("#22c55e", 0.12), color: "#22c55e" }}
                      >
                        ADDED
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
              </label>
            );
          })}
          {rows.length === 0 && catalog.entries.length > 0 && (
            <div className="px-2 py-4 text-[11.5px]" style={{ color: styles.textTertiary }}>
              {/* ROUND-60: honest about BOTH filters — the free-only scope or
                  the search text may each have emptied the list. */}
              {modelsFreeOnly
                ? "No free models match — switch to “All models” or refine the search."
                : `No catalog model matches “${query.trim()}” — add it by id below.`}
            </div>
          )}
        </div>

        {/* footer: manual add-by-id (secondary) + bulk action */}
        <div
          className="shrink-0 border-t px-5 py-3.5 flex flex-col gap-3"
          style={{ borderColor: styles.border, background: withAlpha(styles.accent, 0.02) }}
        >
          <div className="flex items-center gap-2">
            <input
              value={manualId}
              onChange={(e) => setManualId(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && manualId.trim()) addManual.mutate();
              }}
              placeholder="…or add an id not in the list"
              aria-label="Model id"
              className="h-9 flex-1 min-w-0 rounded-[10px] border-[1.5px] px-3 font-mono text-[12px] outline-none"
              style={inputStyle}
            />
            <button
              onClick={() => addManual.mutate()}
              disabled={!manualId.trim() || addManual.isPending}
              className="h-9 px-3.5 rounded-[10px] border-[1.5px] text-[12px] font-bold disabled:opacity-50 shrink-0"
              style={{ borderColor: styles.border, color: styles.textSecondary }}
            >
              {addManual.isPending ? "Adding…" : "Add by id"}
            </button>
          </div>
          {error && (
            <p className="text-[11px]" style={{ color: "#ef4444" }}>
              {error}
            </p>
          )}
          {notice && (
            <p className="text-[11px]" style={{ color: "#22c55e" }}>
              {notice}
            </p>
          )}
          <button
            onClick={() => addSelected.mutate()}
            disabled={selected.size === 0 || addSelected.isPending}
            className="h-10 rounded-full text-[13px] font-bold disabled:opacity-50 transition-transform hover:scale-[1.01] active:scale-[0.99]"
            style={{ background: styles.accent, color: styles.accentText }}
          >
            {addSelected.isPending
              ? "Adding…"
              : selected.size === 0
                ? "Add models"
                : `Add ${selected.size} model${selected.size === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── ROUND-50 (R50-d): the per-model configuration dialog ─────────────────── */

/** Draft state for the config dialog — numerics live as STRINGS so an empty
 * input can mean "unknown" (null) rather than 0. */
interface ModelConfigDraft {
  displayName: string;
  contextWindow: string;
  maxOutputTokens: string;
  inputPrice: string;
  outputPrice: string;
  cachePrice: string;
  supportsThinking: boolean;
  hidden: boolean;
}

function draftFromModel(model: ProviderModelConfig): ModelConfigDraft {
  const num = (v: number | null): string => (v === null ? "" : String(v));
  return {
    displayName: model.displayName || "",
    contextWindow: num(model.contextWindow),
    maxOutputTokens: num(model.maxOutputTokens),
    inputPrice: num(model.inputPricePerMtok),
    outputPrice: num(model.outputPricePerMtok),
    cachePrice: num(model.inputPriceCachedPerMtok),
    supportsThinking: model.supportsThinking,
    hidden: model.hidden,
  };
}

function ModelConfigDialog({
  model,
  onClose,
  onSaved,
}: {
  model: ProviderModelConfig;
  onClose: () => void;
  onSaved: () => void;
}) {
  const styles = useThemeStyles();
  const [draft, setDraft] = useState<ModelConfigDraft>(() => draftFromModel(model));
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof ModelConfigDraft>(key: K, value: ModelConfigDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const save = useMutation({
    mutationFn: (patch: ProviderModelConfigPatch) =>
      updateProviderModelConfig(model.id, patch),
    onSuccess: onSaved,
    onError: (err: Error) => setError(err.message),
  });

  const submit = () => {
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
      displayName: draft.displayName.trim() || model.modelId,
      contextWindow: parsed.contextWindow,
      maxOutputTokens: parsed.maxOutputTokens,
      inputPricePerMtok: parsed.inputPrice,
      outputPricePerMtok: parsed.outputPrice,
      inputPriceCachedPerMtok: parsed.cachePrice,
      supportsThinking: draft.supportsThinking,
      hidden: draft.hidden,
    });
  };

  const inputStyle = {
    background: styles.bg,
    borderColor: styles.border,
    color: styles.text,
  } as const;

  /** The On/Off mini-toggle used for the boolean fields. */
  const Toggle = ({
    label,
    value,
    onChange,
    hint,
  }: {
    label: string;
    value: boolean;
    onChange: (next: boolean) => void;
    hint: string;
  }) => (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <span className="block text-[12px] font-bold" style={{ color: styles.textSecondary }}>
          {label}
        </span>
        <span className="block text-[10.5px]" style={{ color: styles.textTertiary }}>
          {hint}
        </span>
      </div>
      <div
        role="group"
        aria-label={label}
        className="flex items-center rounded-[10px] border-[1.5px] overflow-hidden shrink-0"
        style={{ borderColor: styles.border }}
      >
        {([
          { id: "on", label: "On", active: value, pick: () => onChange(true) },
          { id: "off", label: "Off", active: !value, pick: () => onChange(false) },
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
  );

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
      aria-label="Configure model"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-full max-w-[520px] max-h-[86vh] overflow-y-auto auto-scroll rounded-[20px] border-[1.5px] p-5 flex flex-col gap-4"
        style={{ background: styles.card, borderColor: styles.border, boxShadow: styles.bentoShadow }}
      >
        {/* header */}
        <div className="flex items-center gap-2">
          <span className="text-[15px] font-black" style={{ color: styles.text }}>
            Configure model
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
        <p className="-mt-2 font-mono text-[11px] break-all" style={{ color: styles.textTertiary }}>
          {model.modelId}
        </p>

        {/* display name */}
        <div>
          <label className="mb-1.5 block text-[11px] font-bold" style={{ color: styles.textSecondary }}>
            Display name
          </label>
          <input
            value={draft.displayName}
            onChange={(e) => set("displayName", e.target.value)}
            placeholder={model.modelId}
            aria-label="Display name"
            className="h-10 w-full rounded-[10px] border-[1.5px] px-3 text-[13px] outline-none"
            style={inputStyle}
          />
        </div>

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
          <SectionLabel>Pricing — $ per 1M tokens</SectionLabel>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="mb-1 block text-[10.5px] font-bold" style={{ color: styles.textTertiary }}>
                Input
              </label>
              <input
                value={draft.inputPrice}
                onChange={(e) => set("inputPrice", e.target.value)}
                placeholder="unknown"
                aria-label="Input price ($/Mtok)"
                className="h-10 w-full rounded-[10px] border-[1.5px] px-3 font-mono text-[12px] outline-none"
                style={inputStyle}
              />
            </div>
            <div>
              <label className="mb-1 block text-[10.5px] font-bold" style={{ color: styles.textTertiary }}>
                Output
              </label>
              <input
                value={draft.outputPrice}
                onChange={(e) => set("outputPrice", e.target.value)}
                placeholder="unknown"
                aria-label="Output price ($/Mtok)"
                className="h-10 w-full rounded-[10px] border-[1.5px] px-3 font-mono text-[12px] outline-none"
                style={inputStyle}
              />
            </div>
            <div>
              <label className="mb-1 block text-[10.5px] font-bold" style={{ color: styles.textTertiary }}>
                Cache read
              </label>
              <input
                value={draft.cachePrice}
                onChange={(e) => set("cachePrice", e.target.value)}
                placeholder="unknown"
                aria-label="Cache read price ($/Mtok)"
                className="h-10 w-full rounded-[10px] border-[1.5px] px-3 font-mono text-[12px] outline-none"
                style={inputStyle}
              />
            </div>
          </div>
          <p className="text-[10.5px]" style={{ color: styles.textTertiary }}>
            Leave a field empty for unknown — an empty price is never treated as $0.
          </p>
        </div>

        {/* behavior */}
        <div className="flex flex-col gap-3">
          <SectionLabel>Behavior</SectionLabel>
          <Toggle
            label="Supports thinking"
            value={draft.supportsThinking}
            onChange={(v) => set("supportsThinking", v)}
            hint="The model can emit reasoning output."
          />
          <Toggle
            label="Hidden from chat picker"
            value={draft.hidden}
            onChange={(v) => set("hidden", v)}
            hint="Kept here in Settings, but not offered in the chat model selector."
          />
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

        {error && (
          <p role="alert" className="text-[11.5px]" style={{ color: "#ef4444" }}>
            {error}
          </p>
        )}

        <div className="flex items-center gap-2">
          <button
            onClick={onClose}
            className="h-10 px-4 rounded-[10px] border-[1.5px] text-[12px] font-bold"
            style={{ borderColor: styles.border, color: styles.textSecondary }}
          >
            Cancel
          </button>
          <span className="flex-1" />
          <button
            onClick={submit}
            disabled={save.isPending}
            className="h-10 px-5 rounded-full text-[12.5px] font-bold disabled:opacity-50"
            style={{ background: styles.accent, color: styles.accentText }}
          >
            {save.isPending ? "Saving…" : "Save configuration"}
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
    void queryClient.invalidateQueries({ queryKey: ["settings-providers"] });
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
