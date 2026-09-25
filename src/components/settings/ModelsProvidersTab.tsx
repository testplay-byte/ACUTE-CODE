import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type CSSProperties, type RefObject } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  // R90-A2: the inputs → outputs flow arrow on the model card.
  ArrowRight,
  AudioLines,
  Check,
  Copy,
  Eye,
  EyeOff,
  FileText,
  Globe,
  Image as ImageIcon,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Type,
  Video,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
// ROUND-95 (R95-A): the shared styled confirmation dialog — every
// destructive ask in this tab (pool-key removal, model deletion, provider
// deletion) goes through it; window.confirm is banned app-wide.
import { ConfirmDialog } from "./ConfirmDialog";
// R100-E2: the round-100 primitives (USAGE.md §3) — the settings sweep's
// card/kicker/row spelling. SEMANTIC_COLORS replaces the inline status hexes
// (danger/success — TOKENS.md §7, the documented exception home).
import { Kicker } from "../ui/Kicker";
import { SectionCard } from "../ui/SectionCard";
import { SettingsRow } from "../ui/SettingsRow";
// R126-3f-2: the shared clay toggle (the 3f-1 conversion — accentDeep ON track
// + the well rest) replaces this file's local switch spelling for free.
import { ToggleSwitch } from "../ui/toggle-switch";
import { SEMANTIC_COLORS } from "../../lib/semantics";
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
  type KeyPoolSlot,
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
 *
 * ROUND-95 (R95-A, the owner's UI-overhaul walkthrough): the left provider
 * rail is a TALL fixed panel (h-full, 280px floor — the R58 content-adaptive
 * h-fit retired); the provider delete moved from a bottom Danger zone INTO
 * the header as a trash icon opening the shared styled ConfirmDialog
 * (src/components/settings/ConfirmDialog.tsx — window.confirm is banned);
 * Key 2..N rows mirror Key 1's visual language exactly (bordered h-10 eye +
 * animated Copy + matching trash); the picker is add-then-configure (the
 * pencil configure-first flow retired; already-added models are not SHOWN);
 * the models list sorts NOT-hidden first / hidden LAST and animates the
 * re-sort (framer-motion layout) while keeping the scroll position; the
 * header Test button opens a three-option scope ROW (Test All | Test Only
 * Failed | Test Only Working, divider-separated); the list gap grows to
 * separate the model cards. The R50 "Danger zone" section is gone.
 *
 * ROUND-126 (R126-3f-2, the Clay Companion redesign) — the api tab's
 * MATERIAL re-skin (structure/logic byte-identical): the master list rows
 * carry THE SELECTION GRAMMAR (COMPONENTS §4 — aria-current +
 * bg-accent-tint + text-accent-deep + the 2px bg-accent-deep leading bar,
 * hover wash at rest); the detail pane's cards ride the clay SectionCard
 * (free via the 3f-1 primitive conversion); ALL ~48 arbitrary 1.5px
 * borders retire to the 1px clay-rim hairline (TOKENS §5); every
 * input/stepper/value field = THE WELL + THE RIM (TOKENS §10); the R89-C6
 * test bands + the R118-F testing band ride the §11 badge TONE containers
 * (running/success/danger — behavior byte-identical); the key-pool rows
 * are mono-on-the-well with badge-tone state chips, the quiet-solid
 * accentDeep primary on every CTA, and the outlined-danger species on
 * every destructive control; the three dialogs (AddProvider / AddModels /
 * ModelConfig) are the clay card (the AddProjectDialog spelling —
 * rounded-xl + rim + .ac-clay). ZERO logic changes; every testid/aria/
 * role preserved.
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
 * flags, per-1M-token pricing all live there). ROUND-93 (R93-A9): the
 * ["models-configured"] family (GET /models/configured) joins the fan-out —
 * it is now the PRIMARY source of the Sub-agents picker AND the agent
 * dialog's model datalists, so an add/hide/delete here must reflect there
 * on the next open (not after the 60s staleTime). */
export function invalidateModelConfigEverywhere(
  queryClient: QueryClient,
  providerId: string,
): void {
  void queryClient.invalidateQueries({ queryKey: ["settings-provider-models", providerId] });
  void queryClient.invalidateQueries({ queryKey: ["provider-models-config"] });
  void queryClient.invalidateQueries({ queryKey: ["models-configured"] });
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
 * two constants move together (same review checklist as PRESETS above).
 * R113-d: this set no longer decides which providers COUNT as configured —
 * that is the SERVER's `configured` bit on the wire (R113-a). What survives
 * here is pure detail-pane display logic: `isPreset` hides the Base URL +
 * API-format inputs for fixed-endpoint rows. */
const PRESET_PROVIDER_IDS: ReadonlySet<string> = new Set([
  "anthropic",
  "openai",
  "google",
  "openrouter",
  "nvidia",
]);

/* ── ROUND-50 (R50-d) shared micro-formatting ─────────────────────────────── */

/** R89-C4: the plain compact token count — 1000000 → "1M", 131072 → "131K",
 * 8000 → "8K" (labels like "ctx" live with the caller; unset renders as
 * "—"). Used by the sizing hints + the model card's details strip. */
export function formatTokenCount(tokens: number | null): string {
  if (tokens === null || !Number.isFinite(tokens)) return "—";
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${m >= 10 ? Math.round(m) : Number(m.toFixed(1))}M`;
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}

/** R89-C1: the clean HUMAN name derived from a model id — the LAST path
 * segment, ":free"-style suffixes stripped, separators humanized, acronymish
 * tokens cased. "meta-llama/llama-3.3-70b-instruct:free" → "Llama 3.3 70b
 * Instruct"; "openai/gpt-4o-mini" → "GPT 4o Mini". Falls back to the whole
 * id when nothing sane remains. */
export function cleanModelName(modelId: string): string {
  const tail = modelId.split("/").pop() ?? modelId;
  const stripped = tail.replace(/:[a-z0-9-]+$/i, "");
  const base = stripped.trim() !== "" ? stripped : tail;
  const tokens = base
    .replace(/[-_]+/g, " ")
    .split(/\s+/)
    .filter((t) => t !== "");
  if (tokens.length === 0) return modelId;
  const pretty = tokens.map((t) => {
    // tokens with digits keep their shape ("3.3", "70b", "4o")
    if (/\d/.test(t)) return t;
    // vowel-less short tokens read as acronyms (gpt, glm, sdxl, t5) —
    // word-like ones (mini, nano, flash) stay words.
    if (t.length <= 5 && !/[aeiou]/.test(t)) return t.toUpperCase();
    return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
  });
  return pretty.join(" ");
}

/** R89-C3: the capability META — one icon + one theme color per MODALITY,
 * shared by the config dialog's toggles and the model card's chips (the
 * owner: "each input capability a different theme color and also showing
 * SVG icons alongside the text, the image, the video, the PDF, and the
 * audio. Same goes for the output capabilities too"). */
export interface CapabilityMeta {
  key: string;
  label: string;
  color: string;
  // R91-D: `style` joins the accepted props — the OFF-state icon tints
  // toward its modality color while the pill itself stays neutral.
  Icon: ComponentType<{
    size?: number | string;
    className?: string;
    strokeWidth?: number | string;
    style?: CSSProperties;
  }>;
  inTitle: string;
  outTitle: string;
}

const CAPABILITY_META: readonly CapabilityMeta[] = [
  { key: "text", label: "Text", color: "#64748b", Icon: Type, inTitle: "Accepts text input", outTitle: "Produces text output" },
  { key: "images", label: "Images", color: "#8b5cf6", Icon: ImageIcon, inTitle: "Accepts image inputs", outTitle: "Produces image output" },
  { key: "video", label: "Video", color: "#ec4899", Icon: Video, inTitle: "Accepts video inputs", outTitle: "Produces video output" },
  { key: "pdf", label: "PDF", color: "#f97316", Icon: FileText, inTitle: "Accepts PDF documents", outTitle: "Produces PDF output" },
  { key: "audio", label: "Audio", color: "#22c55e", Icon: AudioLines, inTitle: "Accepts audio inputs", outTitle: "Produces audio output" },
];

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

/** ROUND-87 (R87) → R89-C3/C5: the model card's capability chips — the
 * honest, user-set INPUT/OUTPUT flags rendered as COLORED ICON CHIPS (one
 * theme color + one SVG icon per modality, the owner's directive). Inputs:
 * images (vision), videos, PDFs, audio. Outputs: text, images, video,
 * audio. Reasoning + tool use are deliberately NOT here (the app detects
 * those at runtime — the owner's directive). */
function capabilityChips(
  model: ProviderModelConfig | undefined,
  direction: "in" | "out",
): Array<{ label: string; color: string; title: string; Icon: CapabilityMeta["Icon"] }> {
  if (model === undefined) return [];
  const chips: Array<{ label: string; color: string; title: string; Icon: CapabilityMeta["Icon"] }> = [];
  const push = (meta: CapabilityMeta, on: boolean | null | undefined): void => {
    if (on === true) {
      chips.push({
        label: meta.label,
        color: meta.color,
        title: direction === "in" ? meta.inTitle : meta.outTitle,
        Icon: meta.Icon,
      });
    }
  };
  if (direction === "in") {
    push(CAPABILITY_META[0], true); // text input — always true for chat models
    push(CAPABILITY_META[1], model.supportsVision);
    push(CAPABILITY_META[2], model.supportsVideo);
    push(CAPABILITY_META[3], model.supportsPdf);
    push(CAPABILITY_META[4], model.supportsAudio);
  } else {
    push(CAPABILITY_META[0], model.supportsTextOutput === null ? true : model.supportsTextOutput);
    push(CAPABILITY_META[1], model.supportsImageOutput);
    push(CAPABILITY_META[2], model.supportsVideoOutput);
    push(CAPABILITY_META[4], model.supportsAudioOutput);
  }
  return chips;
}

/** R100-E2: the section micro-label now delegates to the ui/Kicker primitive
 * (THE label tier: 11px/500 uppercase tracking-[0.08em], tertiary ink) — the
 * pre-round-100 10px/font-bold/tracking-widest spelling was the audit's
 * "AI-generated" tell. Kept as a thin local alias so the ten call sites
 * stay untouched (visual-only sweep). */
function SectionLabel({ children }: { children: string }) {
  return <Kicker>{children}</Kicker>;
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

  // R113-d (owner: "It was still showing me all the providers which I could
  // add. It was not showing me the actual providers which were added."): the
  // rail splits into TWO groups off the SERVER's `configured` bit (R113-a
  // wire — custom row OR any held key; pool-aware). "Your providers" sits on
  // top; the remaining presets become the "Add a provider" tier below a
  // divider (still selectable — their detail pane is where the key lands).
  // The ROUND-59 client heuristic (hasKey || !PRESET_PROVIDER_IDS) this
  // replaces was WRONG in both directions: a pool-only provider read
  // unconfigured, and the owner's "which are added" question got answered
  // with a catalog instead of an inventory.
  const configuredProviders = providers.filter((p) => p.configured === true);
  const addableProviders = providers.filter((p) => p.configured !== true);

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
  // is no longer served is cleared and falls to the first remaining
  // CONFIGURED row (R113-d: rows in the addable tier are also selectable,
  // so "gone" means gone from the LIST; when nothing is configured the
  // first addable preset pre-selects — its detail pane is the "add a key"
  // surface, which is exactly where a fresh install should land).
  // Deliberately keyed on `providers` (the query data identity — it only
  // moves when the query resolves or refetches with changed content): an
  // explicit user click is never re-processed, and the null selection the
  // "Add provider" flow may set is not instantly overridden.
  useEffect(() => {
    const hidden =
      selectedId !== null && !providers.some((p) => p.id === selectedId);
    if (hidden) setSelectedId(null);
    if (selectedId === null || hidden) {
      const fallback = configuredProviders[0] ?? addableProviders[0];
      if (fallback) setSelectedId(fallback.id);
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
      {/* ── LEFT: the provider list. ROUND-95 (R95-A, the owner: "make it one
          that is taller by default. It does not adapt its height and if there
          are more providers added then it will only allow the user to scroll
          the providers list"): the R58 content-adaptive h-fit is retired — the
          rail now runs the FULL height of the master–detail row (h-full, the
          same height the right detail pane fills) with a generous 280px floor,
          so it reads as a proper fixed panel; only the INNER list scrolls
          when providers outgrow it. ─────────────────────────────────────── */}
      {/* R100-E2: the rail rides the SectionCard primitive (rounded-2xl /
          1.5px border-line / bg-card) with p-0 — its sections manage their
          own padding; the w-[280px]/h-full/min-h-[280px] contract (R95-A)
          is unchanged. */}
      <SectionCard
        className="w-[280px] shrink-0 h-full min-h-[280px] overflow-hidden flex flex-col p-0"
      >
        {/* R126-3f-2: the rail header's inside-panel divider is the 1px
            hairline on the CSS-var leg (border-line) — the inline
            borderColor style is retired. */}
        <div className="shrink-0 flex items-center gap-2 px-3.5 py-3 border-b border-line">
          <SectionLabel>Providers</SectionLabel>
          {/* ROUND-59 (R59-C, R113-d re-scoped): the count reflects the
              "Your providers" group — the configured inventory the owner
              asked to see first (the addable tier below is a catalog, not
              an inventory). */}
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
            className="px-3.5 py-2 border-b border-line text-[11px] text-danger-deep"
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
          {/* R113-d: GROUP 1 — "Your providers" (the server's configured bit).
              The R59-C flat configured-only list became a two-tier rail: the
              owner asked for HIS providers first, the addable catalog
              second. The group label is an in-content Kicker (the same
              SectionLabel tier the rail header uses). */}
          {!providersQuery.isLoading && (
            <Kicker className="px-2.5 pt-1 pb-1.5">Your providers</Kicker>
          )}
          {/* R113-d: the honest empty line when nothing is configured yet —
              the app's empty-state idiom (one short tertiary line, no card
              ceremony for a rail this narrow). */}
          {!providersQuery.isLoading && configuredProviders.length === 0 && (
            <div className="px-2.5 py-1.5 text-[11px]" style={{ color: styles.textTertiary }}>
              No providers configured yet — add your first below.
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
          {/* R113-d: GROUP 2 — "Add a provider": the unconfigured presets,
              quieter (a + affordance instead of the status dot) under a
              divider. Selecting one still opens its detail pane — that is
              where the key/models land (the R59-C "hidden entirely" rule is
              retired: the owner wants to SEE his providers, not lose the
              path to the catalog). */}
          {addableProviders.length > 0 && (
            <>
              <div className="mx-2.5 my-2 border-t border-line" />
              <Kicker className="px-2.5 pb-1.5">Add a provider</Kicker>
              {addableProviders.map((p) => (
                <ProviderListRow
                  key={p.id}
                  provider={p}
                  active={p.id === selectedId}
                  addable
                  onClick={() => setSelectedId(p.id)}
                />
              ))}
            </>
          )}
        </div>
        {/* + Add provider → the preset-or-custom DIALOG (owner R37) */}
        <div className="shrink-0 p-1.5 border-t border-line">
          <button
            onClick={() => {
              // ROUND-59 (R59-C): no longer deselects — pre-select keeps the
              // detail pane meaningful behind the modal, and Cancel restores
              // the user's context instead of a blank placeholder.
              setAdding(true);
            }}
            /* R126-3f-2: the quiet accent-tint action (TOKENS §1d/§10) — the
               accent-tint container + accentDeep ink on the CSS-var leg, the
               hover wash + the press floor per COMPONENTS §4; the accent-soft /
               accent-faded pair + the JS color leg are retired. */
            className="w-full h-9 flex items-center justify-center gap-1.5 rounded-lg text-[12px] font-semibold transition-colors duration-100 bg-accent-tint text-accent-deep hover:bg-hover active:scale-[0.98] cursor-pointer"
          >
            <Plus size={13} strokeWidth={2.5} /> Add provider
          </button>
        </div>
      </SectionCard>

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
          // R126-3f-2: the placeholder keeps the dashed hairline on the clay
          // rim (TOKENS §5) — the 1.5px border + the inline color are
          // retired; the icon tile is the accent-tint pair.
          <div className="flex-1 min-h-0 grid place-items-center rounded-2xl border border-dashed border-clay-rim">
            <div className="text-center px-6">
              <div
                className="w-12 h-12 mx-auto rounded-xl grid place-items-center bg-accent-tint text-accent-deep"
                aria-hidden
              >
                <Globe size={22} />
              </div>
              <p className="mt-3 text-[13px] font-semibold" style={{ color: styles.text }}>
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
  addable = false,
  onClick,
}: {
  provider: ProviderView;
  active: boolean;
  /** R113-d: rows in the "Add a provider" tier — the trailing status dot
   * becomes a small accent + affordance (the "add this one" signal) and the
   * row stays fully clickable (its detail pane is the add-a-key surface). */
  addable?: boolean;
  onClick: () => void;
}) {
  const styles = useThemeStyles();
  // R92-D3: how many keys the provider holds — the primary (slot 0) plus the
  // pool. `keyCount` rides the same backend wave as the key-juggling work
  // (Task 2-a), so until every sidecar serves it the honest local default is
  // hasKey ? 1 : 0 — never a guess, never a hidden pool.
  const keyCount = provider.keyCount ?? (provider.hasKey ? 1 : 0);
  return (
    <button
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      /* R126-3f-2: THE SELECTION GRAMMAR (COMPONENTS §4/§5 + TOKENS §1d/§10):
         the ACTIVE row = the accent-tint container + the accentDeep ink +
         the 2px accentDeep leading bar; the RESTING row = the hover wash
         (hover:bg-hover) with secondary ink — every leg on the CSS-var
         classes (the old inline accent fill + the 2.5px accent bar are
         retired; aria-current unchanged). */
      className={`relative w-full h-11 flex items-center gap-2.5 px-2.5 rounded-lg transition-colors duration-100 text-left cursor-pointer ${
        active ? "bg-accent-tint" : "hover:bg-hover"
      }`}
    >
      {active && (
        <span
          className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-accent-deep"
          aria-hidden
        />
      )}
      <span
        className="w-7 h-7 shrink-0 rounded-lg grid place-items-center bg-well"
        style={{ color: styles.textSecondary }}
      >
        <Globe size={13} />
      </span>
      <span className="min-w-0 flex-1 flex flex-col items-start">
        <span
          className={`w-full truncate text-[13px] font-medium ${active ? "text-accent-deep" : ""}`}
          style={active ? undefined : { color: styles.textSecondary }}
        >
          {provider.name}
        </span>
        <span
          className="w-full truncate font-mono text-[10px]"
          style={{ color: styles.textTertiary }}
          // ROUND-44 (VLM pass): the row clips the endpoint + wire format to one
          // line — surface the full text on hover so it stays verifiable.
          title={`${provider.baseUrl ?? "no url"} · ${formatLabel(provider.apiFormat)}`}
        >
          {provider.baseUrl ? new URL(provider.baseUrl).host : "no url"} · {formatLabel(provider.apiFormat)}
        </span>
      </span>
      {/* R92-D3: the multi-key count chip — shown once the provider holds at
          least one key; the pool itself is managed (and juggled) in the
          detail pane's API keys card. */}
      {keyCount >= 1 && (
        <span
          data-testid={`provider-key-count-${provider.id}`}
          className="shrink-0 px-1.5 py-0.5 rounded-full text-[10px] font-medium tabular-nums bg-badge-neutral text-badge-neutral-fg"
          title={
            keyCount === 1
              ? "1 API key stored"
              : `${keyCount} API keys stored — if one fails, the next is tried automatically`
          }
        >
          {keyCount} {keyCount === 1 ? "key" : "keys"}
        </span>
      )}
      {/* Status dot: green = key stored; grey = no key. R113-d: addable-tier
          rows trade the dot for the accent + chip — "configured" rows carry
          state, catalog rows carry the action. */}
      {addable ? (
        <span
          data-testid={`provider-add-${provider.id}`}
          className="shrink-0 w-4 h-4 grid place-items-center rounded-full bg-accent-tint text-accent-deep"
          title="Add this provider — open its detail to set the key"
          aria-hidden
        >
          <Plus size={10} strokeWidth={2.5} />
        </span>
      ) : (
        <span
          className="w-2 h-2 shrink-0 rounded-full"
          style={{
            // R126-3f-2: flat hues are for DOTS ONLY (TOKENS §11) — the
            // keyless dot rides the sanctioned border token instead of an
            // inline alpha wash.
            background: provider.hasKey ? SEMANTIC_COLORS.success : styles.border,
          }}
          title={provider.hasKey ? "Key stored" : "No key set"}
        />
      )}
    </button>
  );
}

/* ── Right detail pane (ROUND-37: EVERY provider fully editable) ────────────
 * ROUND-50 (R50-d): re-sectioned into clearly-labeled cards — Header →
 * Connection → API keys → Models → Danger zone — with one consistent
 * spacing rhythm (p-4/p-5 cards, gap-5 between them, uppercase micro-labels
 * matching the rest of the app). R92-D3: "API keys" is ONE unified card
 * (ProviderKeysCard) — the primary editor that used to sit inside Connection
 * and the pool rows that used to be their own card are a single Key 1..N
 * list now. */

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

  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(provider.name);
  const [baseUrlDraft, setBaseUrlDraft] = useState(provider.baseUrl ?? "");
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  /** ROUND-90 (R90-A1, the owner: "I clicked the confirm delete but nothing
   * was happening"): the DELETE failure now renders INLINE right under the
   * header card (R95-A moved the delete affordance into the header — the
   * bottom Danger zone is gone): pre-R90 the mutation's error went to
   * `saveMsg`, which lived in the HEADER card ~1500px ABOVE the Danger zone
   * at the bottom of the scrollable pane, styled in the ACCENT color: a 409
   * ("1 agent still uses this provider") was literally invisible at the
   * click site, the dead click the owner saw. Cleared when the confirm
   * re-arms. */
  const [deleteError, setDeleteError] = useState<string | null>(null);
  /** ROUND-95 (R95-A): the header trash opens the shared styled
   * ConfirmDialog — the browser window.confirm pre-arm flow is retired (the
   * owner: "showing a proper UI popup to confirm the deletion"). */
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  // ROUND-47 (R47-c1): the test surface got explicit selectors — WHICH key
  // (primary or a held pool slot) and WHICH model (or reachability-only) —
  // instead of an invisible "primary key, no model" default. R92-D3: the
  // key editor itself (primary + pool rows) now lives in ProviderKeysCard
  // below — this pane keeps only the CONNECTION test surface.
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
  // SAME query key as ProviderKeysCard's — one shared cache entry per provider.
  const poolQuery = useQuery({
    queryKey: ["key-pool", provider.id],
    queryFn: () => fetchKeyPool(provider.id),
  });
  const heldPoolSlots = (poolQuery.data ?? [])
    .filter((k) => k.slot > 0 && k.hasKey)
    .map((k) => k.slot)
    .sort((a, b) => a - b);
  // ROUND-59 (R59-C): the masked slot-0 (primary) value lived here — R92-D3
  // moved it (and the whole primary-key editor) into ProviderKeysCard, which
  // reads the SAME shared key-pool query.

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
    mutationFn: () => deleteProvider(provider.id, true),
    onSuccess: () => {
      // ROUND-62 (R62-2b): the provider is GONE — its models-config rows went
      // with it (ON DELETE CASCADE), so the session picker's config family
      // is invalidated too (the settings-side prefix invalidation stays).
      // ROUND-90 (R90-A5): the OS-STORED key must go too — the sidecar's
      // DELETE route only clears its IN-MEMORY keyring; without this the
      // Windows Credential Manager entry (ACUTE-CODE/provider/<id>) and the
      // custom-provider note line survive, and re-adding the provider shows
      // "key stored" on the OLD key after the next sidecar spawn (the
      // keys.rs R82-follow-up TODO, now wired).
      // R91-A: the delete is FORCED — agents that referenced the provider
      // were reset server-side to the no-provider state, so the agents cache
      // is invalidated too (the composer needs to see the null provider to
      // surface the model picker honestly).
      if (isTauri()) {
        void import("../onboarding/providers-api").then((m) => m.removeProviderKey(provider.id));
      }
      void queryClient.invalidateQueries({ queryKey: ["settings-provider-models"] });
      void queryClient.invalidateQueries({ queryKey: ["provider-models-config"] });
      // R93-A9: the provider's configured rows went with it (the CASCADE
      // above) — the configured-models family (the Sub-agents picker's +
      // agent dialog's PRIMARY source) must not keep serving them.
      void queryClient.invalidateQueries({ queryKey: ["models-configured"] });
      void queryClient.invalidateQueries({ queryKey: ["agents"] });
      void queryClient.invalidateQueries({ queryKey: ["session"] });
      onDeleted();
    },
    // R90-A1: the failure lands INLINE in the Danger zone (see deleteError)
    // — never in the header card 1500px above the click.
    onError: (err: Error) => setDeleteError(err.message),
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

  // R126-3f-2: the input/stepper material is THE WELL + THE RIM (TOKENS
  // §10 — bg-well + border-clay-rim on the CSS-var leg, text-ink for the
  // value ink); the old `inputStyle` JS leg (bg + borderColor + color) is
  // retired — every site below spells the classes directly.

  return (
    <div className="flex flex-col gap-5">
      {/* ── Header: provider identity + status — R100-E2: the SectionCard
          primitive (now the CLAY card — TOKENS §5/§9, free via 3f-1). */}
      <SectionCard className="p-4 flex items-center gap-3 flex-wrap">
        <span
          className="w-10 h-10 shrink-0 rounded-xl grid place-items-center bg-accent-tint text-accent-deep"
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
              className="h-9 w-full max-w-[320px] rounded-lg border border-clay-rim bg-well px-3 text-[13px] font-medium text-ink outline-none"
            />
          ) : (
            <button
              onClick={() => setEditingName(true)}
              className="flex items-center gap-2 min-w-0"
              title="Click to rename"
            >
              <span className="text-[13px] font-semibold truncate" style={{ color: styles.text }}>
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
            OUTRIGHT). R126-3f-2: the badges are the §11 TONE CONTAINERS
            (success on / neutral off) on the CSS-var leg. */}
        <span
          className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${
            provider.enabled ? "bg-badge-success text-badge-success-fg" : "bg-badge-neutral text-badge-neutral-fg"
          }`}
        >
          {provider.enabled ? "● Enabled" : "○ Disabled"}
        </span>
        <span
          className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${
            provider.hasKey ? "bg-badge-success text-badge-success-fg" : "bg-badge-neutral text-badge-neutral-fg"
          }`}
        >
          {provider.hasKey ? "● Key stored" : "○ No key"}
        </span>
        {/* ROUND-59 (R59-C): the enable/disable toggle acts OUTRIGHT — the
            owner: no "One agent uses this provider" confirm; a disabled
            provider's models simply disappear from the pickers. The agent
            count survives ONLY as this quiet hover tooltip. */}
        <span className="flex items-center gap-1.5">
          <span className="text-[11px] font-medium" style={{ color: styles.textSecondary }}>
            {provider.enabled ? "Enabled" : "Disabled"}
          </span>
          {/* R126-3f-2: the shared ui/ToggleSwitch (the 3f-1 clay conversion —
              accentDeep ON track + the well rest) — same role/aria/title/
              disabled contract, the local 1.5px-bordered spelling retired. */}
          <ToggleSwitch
            checked={provider.enabled}
            onToggle={() => {
              // R59-C: NO gate — the PATCH fires immediately.
              saveDetails.mutate({ enabled: !provider.enabled });
            }}
            label={`Toggle provider ${provider.name}`}
            title={
              provider.enabled
                ? agentsUsingProvider.length > 0
                  ? `${agentsUsingProvider.length} agent(s) use this provider — disabling takes effect immediately`
                  : "Disable this provider"
                : "Re-enable this provider"
            }
            disabled={saveDetails.isPending}
          />
        </span>
        {saveMsg && (
          <span className="text-[11px] font-medium text-accent-deep">{saveMsg}</span>
        )}
        {/* ROUND-95 (R95-A, the owner: "The option to delete a provider should
            not be shown at the very bottom but it should be shown at the very
            top. At the very top there should be a trash can icon"): the delete
            affordance lives IN THE HEADER now — the bottom Danger zone card is
            retired. R100-E2: the JS hover-red pair retired. R126-3f-2: the
            button is the OUTLINED DANGER species (COMPONENTS §4 — 1px
            border-danger-deep + text-danger-deep on the class leg, the
            3a/3b press floor); the click opens the shared styled
            ConfirmDialog (never a browser confirm). */}
        <button
          type="button"
          onClick={() => {
            // A fresh attempt clears the stale inline error first.
            setDeleteError(null);
            setConfirmDeleteOpen(true);
          }}
          aria-label={`Delete provider ${provider.name}`}
          title="Delete provider"
          data-testid="provider-delete-top"
          className="w-9 h-9 shrink-0 grid place-items-center rounded-lg border border-danger-deep text-danger-deep transition-colors duration-100 hover:bg-hover active:scale-[0.98] cursor-pointer"
        >
          <Trash2 size={14} />
        </button>
      </SectionCard>

      {/* R90-A1 → R95-A: the delete failure lands INLINE directly under the
          header (the click site is the header trash now) — in the danger
          color, announced to screen readers. R126-3f-2: status text = the
          §11 deep pair on the class leg. */}
      {deleteError !== null && (
        <p
          className="-mt-3 text-[11px] font-medium text-danger-deep"
          role="alert"
          data-testid="delete-provider-error"
        >
          {deleteError}
        </p>
      )}

      {/* ── Connection: base URL / API format / key + test — R100-E2: the
          SectionCard primitive. ───────────────────────────────────── */}
      <SectionCard className="p-4 md:p-5 flex flex-col gap-4">
        <SectionLabel>Connection</SectionLabel>
        {/* ROUND-58 (R58-d): PRESET providers (the seeded built-ins) hide the
            Base URL input + API-format grid — endpoint and format are fixed
            (the owner: "It should only be shown for custom providers"). The
            API-key input + Test connection below stay for EVERY provider. */}
        {isPreset ? (
          <p className="text-[11px]" style={{ color: styles.textTertiary }} data-preset-note>
            Preset provider — endpoint and format are fixed.
          </p>
        ) : (
          <>
            {/* Base URL (editable — custom providers; owner R37) */}
            <div>
              <label className="mb-1.5 block text-[11px] font-medium" style={{ color: styles.textSecondary }}>
                Base URL
              </label>
              <div className="flex gap-2">
                <input
                  value={baseUrlDraft}
                  onChange={(e) => setBaseUrlDraft(e.target.value)}
                  aria-label="Base URL"
                  className="h-10 flex-1 min-w-0 rounded-lg border border-clay-rim bg-well px-3 font-mono text-[12px] text-ink outline-none"
                />
                {baseUrlDraft.trim() !== (provider.baseUrl ?? "") && (
                  <button
                    onClick={() => saveDetails.mutate({ baseUrl: baseUrlDraft.trim() })}
                    /* R126-3f-2: the QUIET-SOLID clay primary (COMPONENTS §4 —
                       the AddProjectDialog spelling): the accentDeep fill on
                       the class leg + the accentText ink on the JS leg
                       (text-accent-text is a phantom utility), rounded-lg,
                       the ac-clay-pressed press collapse. */
                    className="ac-clay-pressed h-10 px-4 rounded-lg text-[12px] font-semibold bg-accent-deep transition-transform active:scale-[0.98] cursor-pointer"
                    style={{ color: styles.accentText }}
                  >
                    Save
                  </button>
                )}
              </div>
            </div>
            {/* API format — ROUND-37: the REAL selector (3 formats) */}
            <div>
              <label className="mb-1.5 block text-[11px] font-medium" style={{ color: styles.textSecondary }}>
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
                      /* R126-3f-2: the segmented selection material — the 1px
                         clay rim + the well rest, the accentTint/accentDeep
                         ACTIVE segment (the ModelSelector spelling); the
                         1.5px border + the withAlpha legs are retired. */
                      className={`h-10 rounded-lg border text-[12px] font-semibold transition-colors duration-100 cursor-pointer ${
                        active
                          ? "border-accent-deep bg-accent-tint text-accent-deep"
                          : "border-clay-rim bg-well hover:bg-hover"
                      }`}
                    >
                      {f.label}
                    </button>
                  );
                })}
              </div>
              <p className="mt-1.5 text-[11px]" style={{ color: styles.textTertiary }}>
                {API_FORMATS.find((f) => f.id === (provider.apiFormat ?? "chat-completions"))?.hint}
              </p>
            </div>
          </>
        )}
        {/* Test connection — ROUND-47 (R47-c1): WHICH key + WHICH model are
            explicit now (key selector over the primary + held pool slots,
            model selector over the live catalog; "(reachability only)" is
            the honest default — a cheap ping that does NOT prove the key).
            R92-D3: the key options carry the same DISPLAY ordinals as the
            API keys card (Key 1 = primary, Key 2..N = the pool in order) —
            the raw slot number stays the wire's internal detail. */}
        <div className="flex items-center gap-2.5 flex-wrap pt-1">
          <select
            aria-label="Test key"
            title="Which key the probe uses"
            value={testKeyChoice === "primary" ? "primary" : String(testKeyChoice)}
            onChange={(e) =>
              setTestKeyChoice(e.target.value === "primary" ? "primary" : Number(e.target.value))
            }
            className="h-9 rounded-lg border border-clay-rim bg-well px-2 text-[11px] outline-none cursor-pointer"
            style={{ color: styles.textSecondary }}
          >
            <option value="primary">Key 1 (primary)</option>
            {heldPoolSlots.map((slot) => (
              <option key={slot} value={String(slot)}>
                Key {keyOrdinal(slot, provider.hasKey, heldPoolSlots)}
              </option>
            ))}
          </select>
          <select
            aria-label="Test model"
            title="A model upgrades the ping to a real one-token completion"
            value={testModel}
            onChange={(e) => setTestModel(e.target.value)}
            disabled={catalogQuery.isFetching && catalogEntries.length === 0}
            className="h-9 max-w-[260px] rounded-lg border border-clay-rim bg-well px-2 text-[11px] outline-none cursor-pointer disabled:opacity-50"
            style={{ color: styles.textSecondary }}
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
            /* R126-3f-2: the SECONDARY species (COMPONENTS §4) — the 1px
               border-strong outline + secondary ink + the hover bg-subtle
               wash + the press floor; the 1.5px border and the JS legs are
               retired. */
            className="ac-clay-pressed h-9 px-3.5 rounded-lg border border-line-strong text-[12px] font-semibold flex items-center gap-1.5 transition-colors duration-100 hover:bg-subtle active:scale-[0.98] disabled:opacity-50 cursor-pointer"
            style={{ color: styles.textSecondary }}
          >
            {testState.kind === "testing" ? <RefreshCw size={12} className="animate-spin" /> : <Zap size={12} />}
            Test connection
          </button>
          {testState.kind === "ok" && (
            <span className="text-[11px] font-medium text-success-deep">
              <Check size={11} className="inline" /> Connected · {testState.ms}ms
              {testState.model ? ` · ${testState.model}` : ""}
            </span>
          )}
          {testState.kind === "fail" && (
            <span className="text-[11px] font-medium break-all text-danger-deep">
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
            <span className="text-[11px]" style={{ color: styles.textTertiary }}>
              {testState.note}
            </span>
          )}
          {provider.apiFormat === "anthropic-messages" && (
            <span className="text-[11px]" style={{ color: styles.textTertiary }}>
              Connection test probes the OpenAI-compatible surface — full adapter testing is pending.
            </span>
          )}
        </div>
      </SectionCard>

      {/* ── API keys (R92-D3: ONE unified card — Key 1 = the primary editor,
          Key 2..N = the pool rows, then the always-on add row. The old
          split — a key field inside Connection + a separate "API key pool"
          card — is retired; the primary and the pool are ONE list now. */}
      <ProviderKeysCard provider={provider} />

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

      {/* ROUND-95 (R95-A): the provider delete confirm — the header trash's
          styled popup (the bottom Danger zone card is retired; the owner's
          exact message). The pre-armed agents warning rides the dialog body
          (R90-A1's honesty contract — the referencing agents are named BEFORE
          the click), and the delete failure lands in the inline
          delete-provider-error line under the header. */}
      {confirmDeleteOpen && (
        <ConfirmDialog
          title="Delete provider"
          message="Do you want to delete this provider and all the models added in it?"
          confirmLabel="Delete provider"
          danger
          onConfirm={() => {
            // R90-A1: a fresh attempt clears the stale inline error first.
            setDeleteError(null);
            setConfirmDeleteOpen(false);
            removeProvider.mutate();
          }}
          onClose={() => setConfirmDeleteOpen(false)}
        >
          {agentsUsingProvider.length > 0 ? (
            <p
              className="text-[11px] font-medium text-danger-deep"
              data-testid="delete-used-by-warning"
            >
              In use by {agentsUsingProvider.length} agent{agentsUsingProvider.length === 1 ? "" : "s"}:{" "}
              {agentsUsingProvider.map((a) => a.name).join(", ")} — confirming the delete resets
              {" "}{agentsUsingProvider.length === 1 ? "it" : "them"} to pick a new model (the chat's model picker
              will ask on the next send).
            </p>
          ) : null}
        </ConfirmDialog>
      )}
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

  const valid = name.trim().length > 0 && !nameTaken && /^https?:\/\/.+/.test(baseUrl.trim());
  // R126-3f-2: the dialog's inputs ride the well + rim on the CSS-var leg
  // (TOKENS §10) — the shared `inputStyle` JS leg is retired.

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
        /* R126-3f-2: the DIALOG = the clay card (the AddProjectDialog
           spelling — rounded-xl + the 1px clay rim + .ac-clay; TOKENS §5/§9:
           the card's depth IS the clay shadow, the 1.5px border + the
           softShadow leg are retired). */
        className="ac-clay w-full max-w-[520px] max-h-[86vh] overflow-y-auto auto-scroll rounded-xl border p-5 flex flex-col gap-4"
        style={{ background: styles.card, borderColor: styles.clayRim }}
      >
        {preset === null ? (
          <>
            {/* STEP 1: what kind of provider? (owner: "is he going to add a
                custom provider or is he going to add others from the list") */}
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-semibold" style={{ color: styles.text }}>
                Add provider
              </span>
              <span className="flex-1" />
              <button
                onClick={onClose}
                aria-label="Close"
                className="w-7 h-7 grid place-items-center rounded-lg"
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
                    /* R126-3f-2: the preset tile = the WELL recess + the clay
                       rim (TOKENS §10) with the rim→strong hover swap
                       (COMPONENTS §3, 120ms max) — the 1.5px border + the
                       bg-bg fill + the JS legs are retired. */
                    className="h-12 px-4 rounded-xl border border-clay-rim bg-well flex items-center gap-3 text-left transition-colors duration-100 hover:border-line-strong hover:bg-hover cursor-pointer"
                    style={{ color: styles.text }}
                  >
                    <span
                      className="w-8 h-8 shrink-0 rounded-lg grid place-items-center bg-accent-tint text-accent-deep"
                      aria-hidden
                    >
                      <Globe size={14} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium truncate">{p.name}</span>
                      <span className="block text-[11px] truncate" style={{ color: styles.textTertiary }}>
                        {p.blurb}
                      </span>
                    </span>
                    {configured ? (
                      <span
                        className="shrink-0 text-[10px] font-medium px-2 py-0.5 rounded-full bg-badge-success text-badge-success-fg"
                        title="Already configured — you can still add another one under a different name"
                      >
                        configured
                      </span>
                    ) : null}
                    <span className="shrink-0 text-[11px] font-medium text-accent-deep">
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
                className="w-7 h-7 grid place-items-center rounded-lg"
                style={{ color: styles.textTertiary }}
              >
                <ArrowLeft size={14} />
              </button>
              <span className="text-[13px] font-semibold" style={{ color: styles.text }}>
                {preset.id === "custom" ? "Custom provider" : preset.name}
              </span>
              <span className="flex-1" />
              <button
                onClick={onClose}
                aria-label="Close"
                className="w-7 h-7 grid place-items-center rounded-lg"
                style={{ color: styles.textTertiary }}
              >
                <X size={14} />
              </button>
            </div>

            <div>
              <label className="mb-1.5 block text-[11px] font-medium" style={{ color: styles.textSecondary }}>
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
                className={`h-10 w-full rounded-lg border border-clay-rim bg-well px-3 text-[13px] text-ink outline-none ${
                  nameTaken ? "border-danger-deep" : ""
                }`}
              />
              {nameTaken ? (
                <p className="mt-1.5 text-[11px] text-danger-deep" role="alert">
                  That name is already in use — every provider needs a distinct display name.
                </p>
              ) : (
                <p className="mt-1.5 text-[11px]" style={{ color: styles.textTertiary }}>
                  The display name is the only thing that must be unique.
                </p>
              )}
            </div>
            <div>
              <label className="mb-1.5 block text-[11px] font-medium" style={{ color: styles.textSecondary }}>
                Base URL
              </label>
              <input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.example.com/v1"
                aria-label="Base URL"
                className="h-10 w-full rounded-lg border border-clay-rim bg-well px-3 font-mono text-[12px] text-ink outline-none"
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
                  className="text-[11px] font-medium uppercase tracking-wider px-2.5 py-1 rounded-full bg-badge-neutral text-badge-neutral-fg"
                >
                  {formatLabel(apiFormat)}
                </span>
                <span className="text-[11px]" style={{ color: styles.textTertiary }}>
                  preset for {preset?.name} — nothing to pick
                </span>
              </div>
            ) : (
              <div>
                <label className="mb-1.5 block text-[11px] font-medium" style={{ color: styles.textSecondary }}>
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
                        /* R126-3f-2: the segmented selection material — the 1px
                           clay rim + the well rest, the accentTint/accentDeep
                           ACTIVE segment (the ModelSelector spelling). */
                        className={`h-9 rounded-lg border text-[11px] font-semibold transition-colors duration-100 cursor-pointer ${
                          active
                            ? "border-accent-deep bg-accent-tint text-accent-deep"
                            : "border-clay-rim bg-well hover:bg-hover"
                        }`}
                      >
                        {f.label}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-1.5 text-[11px]" style={{ color: styles.textTertiary }}>
                  {API_FORMATS.find((f) => f.id === apiFormat)?.hint}
                </p>
              </div>
            )}
            <div>
              <label className="mb-1.5 block text-[11px] font-medium" style={{ color: styles.textSecondary }}>
                API key <span style={{ color: styles.textTertiary }}>(optional — can be added later)</span>
              </label>
              <div className="relative">
                <input
                  type={showKey ? "text" : "password"}
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder="sk-…"
                  aria-label="API key"
                  className="h-10 w-full rounded-lg border border-clay-rim bg-well px-3 pr-10 font-mono text-[12px] text-ink outline-none"
                />
                <button
                  onClick={() => setShowKey((v) => !v)}
                  aria-label={showKey ? "Hide key" : "Show key"}
                  className="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 grid place-items-center rounded-lg"
                  style={{ color: styles.textTertiary }}
                >
                  {showKey ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
              </div>
            </div>

            {error && (
              <p role="alert" className="text-[12px] text-danger-deep">
                {error}
              </p>
            )}

            <button
              onClick={() => create.mutate()}
              disabled={!valid || create.isPending}
              /* R126-3f-2: the QUIET-SOLID clay primary (COMPONENTS §4 — the
                 AddProjectDialog spelling): the accentDeep fill on the class
                 leg + the accentText ink on the JS leg, rounded-lg (the input
                 radius), the ac-clay-pressed press collapse; the accent fill
                 + the pill radius are retired. */
              className="ac-clay-pressed h-11 rounded-lg text-[13px] font-semibold bg-accent-deep transition-transform active:scale-[0.98] disabled:opacity-50 cursor-pointer"
              style={{ color: styles.accentText }}
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
  /** R89-C5: the human parameter size ("70B") for the card's badge. */
  sizeLabel: string | null;
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
    sizeLabel: m.sizeLabel ?? null,
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
      sizeLabel: null,
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
// ── R89-C6: the model TEST machinery, split into a shared hook + two views ──
//
// The owner's verdict: the old inline result "was taking up way too much
// space and it was looking ugly… the whole layout broke". The test state now
// lives in `useModelTest` (one definition); the LIST renders it as a
// DEDICATED SECTION that expands below the model card (top half unchanged);
// the config dialog keeps the compact inline line (its footer row).

/** ROUND-119 (R119-P): the TOOLS leg carried on both verdict states — the
 * agent-readiness verdict (the owner's TokenHarbor report: plain chat
 * worked while every agent action failed, because the old probe never sent
 * tools). undefined = the leg never ran (the pong phase failed first). */
export interface ModelTestToolsLeg {
  accepted: boolean;
  called: boolean;
}

/**
 * ROUND-119 (R119-P) — the tools leg's ONE-LINE verdict for the test bands
 * (pure; both views render it as a single line in the band's own 11px
 * typography): "tools ✓ — called echo" (the agent works), "tools accepted —
 * answered in text, not called" (a chat-only model — the honest caution),
 * or "tools rejected — {reason snippet}" (THE TokenHarbor shape: the
 * provider refuses the agent's tool-carrying calls). null = the leg never
 * ran; no line, never a guess.
 */
export function modelTestToolsLine(
  tools: ModelTestToolsLeg | undefined,
  reason?: string,
): string | null {
  if (tools === undefined) return null;
  if (!tools.accepted) {
    const raw = reason ?? "the provider refused the tools request";
    const snippet = raw.slice(0, 140);
    return `tools rejected — ${snippet}${raw.length > 140 ? "…" : ""}`;
  }
  if (tools.called) return "tools ✓ — called echo";
  return "tools accepted — answered in text, not called";
}

export type ModelTestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | {
      kind: "pass";
      latencyMs: number;
      preview?: string;
      usage?: { inputTokens: number; outputTokens: number };
      /** R119-P — the tools leg (present whenever the probe ran it). */
      tools?: ModelTestToolsLeg;
    }
  | {
      kind: "fail";
      reason: string;
      /** R119-P — the tools leg (a tools rejection IS the failure — the
       * line names it distinctly). */
      tools?: ModelTestToolsLeg;
    };

/** R124: how long a FAIL verdict stays on screen before it dismisses
 * itself (the owner: "it shows me the error message, which is proper, but
 * that error message does not disappear automatically after some time").
 * 12s — long enough to read the reason (and open the raw-reason toggle),
 * short enough that a stale failure never lingers over the list. A fresh
 * test re-arms it; PASS verdicts stay (they are the quiet confirmation). */
const MODEL_TEST_FAIL_DISMISS_MS = 12_000;

function useModelTest(model: ProviderModelConfig | null): { state: ModelTestState; run: () => void } {
  const [state, setState] = useState<ModelTestState>({ kind: "idle" });
  // R124: the auto-dismiss timer — armed when a FAIL lands, cleared by any
  // state change (a fresh test or an unmount). The effect's cleanup IS the
  // re-arm mechanism: a new state object re-runs it.
  useEffect(() => {
    if (state.kind !== "fail") return;
    const dismiss = setTimeout(() => setState({ kind: "idle" }), MODEL_TEST_FAIL_DISMISS_MS);
    return () => clearTimeout(dismiss);
  }, [state]);
  const run = (): void => {
    if (model === null) return;
    setState({ kind: "testing" });
    testModelConnection(model.id)
      .then((result) => {
        // R119-P: the tools leg rides BOTH verdict states (absent when the
        // pong phase failed first — the leg never ran). Read defensively:
        // the wire has carried `checks` since R82, but a malformed/legacy
        // body (or a test fixture) without it degrades to "not run", never
        // a crash.
        const tools: ModelTestToolsLeg | undefined =
          result.checks?.toolsAccepted === undefined
            ? undefined
            : { accepted: result.checks.toolsAccepted, called: result.checks.toolCalled === true };
        if (result.ok) {
          setState({
            kind: "pass",
            latencyMs: result.latencyMs,
            ...(result.contentPreview !== undefined ? { preview: result.contentPreview } : {}),
            ...(result.usage !== undefined ? { usage: result.usage } : {}),
            ...(tools !== undefined ? { tools } : {}),
          });
        } else {
          setState({
            kind: "fail",
            reason: result.reason ?? "the probe failed without a reason",
            ...(tools !== undefined ? { tools } : {}),
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
  return { state, run };
}

/** The R87 animation/tint contract: the button spins while testing, then
 * tints light green/red for 5s (a fresh test re-arms it; the 300ms
 * transition rides the button's own background). */
function useTestTint(state: ModelTestState): { tinted: boolean; outcome: "pass" | "fail" | null } {
  const [tinted, setTinted] = useState(false);
  useEffect(() => {
    if (state.kind !== "pass" && state.kind !== "fail") return;
    setTinted(true);
    const hide = setTimeout(() => setTinted(false), 5_000);
    return () => clearTimeout(hide);
  }, [state]);
  const outcome = state.kind === "pass" ? "pass" : state.kind === "fail" ? "fail" : null;
  return { tinted, outcome };
}

/** The presentational TEST button (both views share it). R94-C adds the
 * `segment` variant — the model ROW's unified action-group look (bordered
 * cluster, per-button dividers, pressed scale, focus ring) — while the
 * config dialog keeps the bare ghost icon (its compact footer-line
 * contract). The R87 animation/tint contract is IDENTICAL in both: the
 * button spins while testing, then tints light green/red for 5s, with the
 * 300ms transition riding the button's own background. */
function TestIconButton({
  model,
  state,
  run,
  label,
  variant = "ghost",
}: {
  model: ProviderModelConfig;
  state: ModelTestState;
  run: () => void;
  label?: string;
  variant?: "ghost" | "segment";
}) {
  const styles = useThemeStyles();
  const { tinted, outcome } = useTestTint(state);
  const testing = state.kind === "testing";
  // R94-C: the settled outcome keeps its icon color — the hover only swaps
  // the color of an UNTINTED, UNANSWERED button to the accent.
  // R126-3f-2: status ink = the §11 DEEP pairs (styles.successDeep /
  // dangerDeep) — the flat SEMANTIC hues are for DOTS only now.
  const baseColor = outcome === "pass" ? styles.successDeep : outcome === "fail" ? styles.dangerDeep : styles.textSecondary;
  return (
    <button
      onClick={run}
      disabled={testing}
      aria-label={`Test model ${model.displayName || model.modelId}`}
      title="Send a real test request to this model — checks the key, the model id, and the reply"
      data-testid="model-test-button"
      data-model-row={model.id}
      className={[
        "h-8 shrink-0 text-[11px] font-medium transition-all duration-300 flex items-center justify-center gap-1.5",
        // R94-C: the pressed scale + the focus-visible ring (drawn INSIDE
        // the button edge, so the row cluster's overflow-hidden rounding
        // never clips it).
        "active:scale-[0.92] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--ac-accent)]",
        variant === "segment" ? "w-8 px-0" : "rounded-lg px-2.5",
        /* R100-E2: an UNTINTED button gets the accent-soft CSS wash
           (TOKENS.md §6). R126-3f-2: the TINTED one rides the §11 badge
           TONE CONTAINERS (success/danger) on the class leg — the R87
           spin/5s-tint/pass-fail contract is byte-identical, only the
           material moved. */
        "hover:bg-accent-soft",
        tinted && outcome === "pass" ? "bg-badge-success text-badge-success-fg" : "",
        tinted && outcome === "fail" ? "bg-badge-danger text-badge-danger-fg" : "",
      ].join(" ")}
      style={{
        width: label === undefined ? 32 : undefined,
        // The tone classes own the tinted ink; the JS leg colors only the
        // untinted rest (secondary) + the settled-icon deep pairs.
        color: tinted ? undefined : baseColor,
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
      {label !== undefined && <span className="text-[11px] font-medium">{label}</span>}
    </button>
  );
}

/** The config dialog's footer test button — the compact inline result line
 * (kept from R87; the dialog's footer row is the right home for it).
 * R118-F (round-118 §1 item 26, the R87 supersession): the line renders
 * ALSO while the probe runs (a one-line spinning "Testing {model}…" row —
 * the old busy cue was a 12px spinner buried in a 32px icon-only button);
 * a FAIL persists (never auto-collapses — an error the owner must read
 * never snaps away); a PASS folds at 10s (was 5 — a 2-10s real completion
 * plus a 5s vanish read as "no status at all"). The useTestTint 5s tint
 * stays as-is. */
function ModelTestButton({ model }: { model: ProviderModelConfig }) {
  const styles = useThemeStyles();
  const { state, run } = useModelTest(model);
  const [showReply, setShowReply] = useState(false);
  const [showFull, setShowFull] = useState(false);
  // R118-F: pass folds at 10s. R124: the fail AUTO-DISMISSES at 12s — the
  // owner's new verdict ("that error message does not disappear
  // automatically after some time") supersedes R118-F's "never" — the
  // dismissal lives in useModelTest itself (the hook resets to idle), so
  // this view only arms the PASS fold.
  const [showResult, setShowResult] = useState(false);
  useEffect(() => {
    if (state.kind !== "pass" && state.kind !== "fail") return;
    setShowResult(true);
    if (state.kind === "fail") return; // R124: the hook's 12s timer owns the fail
    const hide = setTimeout(() => setShowResult(false), 10_000);
    return () => clearTimeout(hide);
  }, [state]);
  // R119-P — the tools leg's one-line verdict (the agent-readiness line;
  // null when the leg never ran). One computation, both verdict branches.
  // R126-3f-2: status ink = the §11 deep pairs on the JS leg.
  const toolsLine =
    state.kind === "pass" || state.kind === "fail"
      ? modelTestToolsLine(state.tools, state.kind === "fail" ? state.reason : undefined)
      : null;
  const toolsColor =
    state.kind === "fail"
      ? styles.dangerDeep
      : state.kind === "pass" && state.tools?.called
        ? styles.successDeep
        : styles.warningDeep;

  return (
    <>
      <TestIconButton model={model} state={state} run={run} />
      <AnimatePresence>
        {(state.kind === "testing" || (showResult && (state.kind === "pass" || state.kind === "fail"))) && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.22, ease }}
            className="w-full min-w-0 px-1 pb-1 overflow-hidden"
            data-testid="model-test-result"
            data-model-test={state.kind}
          >
            {state.kind === "testing" ? (
              /* R126-3f-2: the TESTING band = the running badge tone
                 (bg-badge-running + text-badge-running-fg, TOKENS §11) with
                 the spinner — the R118-F "shows while testing" contract
                 byte-identical, only the material moved. */
              <div
                className="flex items-center gap-1.5 text-[11px] rounded-lg px-2.5 py-1.5 bg-badge-running text-badge-running-fg"
                data-testid="model-test-busy"
              >
                <RefreshCw size={12} className="animate-spin" aria-hidden />
                Testing {model.displayName || model.modelId}…
              </div>
            ) : state.kind === "pass" ? (
              <div className="flex flex-col gap-0.5 min-w-0">
                <div className="flex items-center gap-2 flex-wrap text-[11px]">
                  <span className="font-medium text-success-deep">
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
                      className="font-medium underline underline-offset-2"
                      style={{ color: styles.textTertiary }}
                      data-testid="model-test-show-reply"
                    >
                      {showReply ? "Hide reply" : "Show reply"}
                    </button>
                  )}
                </div>
                {/* R119-P — the tools leg: one line, the band's own 11px
                    typography; success when the model CALLED echo, warning
                    when it answered in text (chat-only — the honest
                    caution). */}
                {toolsLine !== null ? (
                  <div
                    className="text-[11px] font-medium"
                    style={{ color: toolsColor }}
                    data-testid="model-test-tools"
                  >
                    {toolsLine}
                  </div>
                ) : null}
                {showReply && state.preview !== undefined && (
                  <div
                    className="font-mono text-[11px] break-all rounded-sm px-2 py-1 max-h-24 overflow-y-auto bg-well border border-clay-rim"
                    style={{ color: styles.textSecondary }}
                  >
                    {state.preview}
                  </div>
                )}
              </div>
            ) : (
              <div className="flex flex-col gap-0.5 min-w-0">
                {/* R119-P — the tools rejection named distinctly (danger):
                    the reason below carries the full raw body; this line is
                    the scannable "the AGENT path is dead" verdict. */}
                {toolsLine !== null ? (
                  <div
                    className="text-[11px] font-medium text-danger-deep"
                    data-testid="model-test-tools"
                  >
                    {toolsLine}
                  </div>
                ) : null}
                <div
                  className="text-[11px] break-all text-danger-deep"
                  data-testid="model-test-reason"
                >
                  {showFull ? state.reason : `${state.reason.slice(0, 240)}${state.reason.length > 240 ? "…" : ""}`}
                </div>
                {state.reason.length > 240 && (
                  <button
                    onClick={() => setShowFull(!showFull)}
                    className="text-[11px] font-medium underline underline-offset-2 self-start"
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

// ── R89-C5/C6: the MODEL CARD — the bordered card with DEDICATED SECTIONS ──
//
// The owner's directive: "the details should be shown in the dedicated
// sections and should be handled properly. The left section and the right
// section should be separate from each other. Also in the left section where
// it shows the details, the details should be formatted into dedicated
// sections and areas properly, like: the total in context, the input price,
// output price, the cache read, all the capabilities." And for the test
// result: "the size of the model should expand: the top half should remain
// exactly as it was. At the bottom a new dedicated section should appear
// just below that model and there the details should be shown."
function ModelCard({
  m,
  row,
  onEdit,
  onDelete,
  onToggleHidden,
  testAllSeq,
  onTestAllResult,
}: {
  m: MergedModel;
  row: ProviderModelConfig | null;
  onEdit: () => void;
  onDelete: () => void;
  /** R93-A7: the hide/show quick toggle — PATCHes {hidden: !hidden} and
   * invalidates; the 4th action button (Eye/EyeOff). */
  onToggleHidden?: () => void;
  /** R93-A7: the Test-All driver — a bumped seq runs THIS card's test
   * (each card owns its own useModelTest state, so the per-card result
   * sections render exactly as a manual click). R94-C: the header now scopes
   * the pulse — a card OUTSIDE the chosen scope (not "all", or its last
   * recorded result doesn't match) simply never receives the new seq. */
  testAllSeq?: number;
  /** R93-A7 → R94-C: the card reports every SETTLED test back to the
   * header. `seq` identifies the bulk pulse the run answers (null = a
   * manual row-button click: the scope map records it, the progress counter
   * ignores it); `rowId` feeds the Test-scope dropdown's memory. */
  onTestAllResult?: (seq: number | null, ok: boolean, rowId: string | null) => void;
}) {
  const styles = useThemeStyles();
  const { state, run } = useModelTest(row);
  const [showReply, setShowReply] = useState(false);
  const [showFull, setShowFull] = useState(false);
  const [showResult, setShowResult] = useState(false);
  const hideTimerRef = useRef<number | null>(null);
  // R119-P — the tools leg's one-line verdict (the agent-readiness line;
  // null when the leg never ran — the pong phase failed first). One
  // computation, both verdict branches of the band below.
  // R126-3f-2: status ink = the §11 deep pairs on the JS leg.
  const toolsLine =
    state.kind === "pass" || state.kind === "fail"
      ? modelTestToolsLine(state.tools, state.kind === "fail" ? state.reason : undefined)
      : null;
  const toolsColor =
    state.kind === "fail"
      ? styles.dangerDeep
      : state.kind === "pass" && state.tools?.called
        ? styles.successDeep
        : styles.warningDeep;

  // ── R93-A7 → R94-C: the Test-All wiring. A new seq fires the card's own
  // test once; every SETTLED outcome is reported to the header through the
  // card channel. The old boolean settledRef had a latent double-count on a
  // SECOND pulse (the still-settled state from the PREVIOUS run reported
  // the STALE outcome for the new seq and then suppressed the fresh one) —
  // the prev-kind guard below only reports when the state actually
  // TRANSITIONS into pass/fail, which also lets MANUAL row-button clicks
  // report (seq null) without touching the bulk counter. */
  const runInfoRef = useRef<{ seq: number | null }>({ seq: null });
  useEffect(() => {
    if (testAllSeq === undefined || testAllSeq === 0 || row === null) return;
    runInfoRef.current = { seq: testAllSeq };
    run();
    // run is the card-local stable callback; testAllSeq changes only when
    // the header button is clicked again.
  }, [testAllSeq]);
  // A manual click on the row's Test segment — same probe, but it reports
  // with seq null (the scope map records the outcome, the counter doesn't).
  const runManual = (): void => {
    runInfoRef.current = { seq: null };
    run();
  };
  const prevKindRef = useRef<ModelTestState["kind"]>("idle");
  useEffect(() => {
    const kind = state.kind;
    const wasSettled = prevKindRef.current === "pass" || prevKindRef.current === "fail";
    prevKindRef.current = kind;
    if (kind !== "pass" && kind !== "fail") return;
    // A re-fire with an already-settled state (the seq prop or the row
    // object changed) is NOT a fresh settle — never report it.
    if (wasSettled) return;
    onTestAllResult?.(runInfoRef.current.seq, kind === "pass", row?.id ?? m.rowId ?? null);
  }, [state, testAllSeq, onTestAllResult, row, m]);

  // The section appears on completion — and R118-F (round-118 §1 item 26,
  // the R87 supersession): a PASS auto-folds after 10s (was 5 — a 2-10s
  // real completion plus a 5s vanish read as "no status at all"), and the
  // section renders WHILE TESTING too (the one-line busy row —
  // "Testing {model}…"). UNLESS the owner interacts with it (Show reply /
  // Show full cancels the timer — the reader keeps the section as long as
  // they are reading). R124 supersedes the FAIL half of R118-F: a fail now
  // AUTO-DISMISSES at 12s (useModelTest's own timer — the owner: "that
  // error message does not disappear automatically after some time"); this
  // view arms only the PASS fold.
  useEffect(() => {
    if (state.kind !== "pass" && state.kind !== "fail") return;
    setShowResult(true);
    if (state.kind === "fail") return; // R118-F: a fail stays until dismissed/retested
    hideTimerRef.current = window.setTimeout(() => {
      setShowResult(false);
      hideTimerRef.current = null;
    }, 10_000);
    return () => {
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    };
  }, [state]);
  const keepOpen = (): void => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  };

  const inChips = row !== null ? capabilityChips(row, "in") : [];
  const outChips = row !== null ? capabilityChips(row, "out") : [];
  // R94-C: the action group's divider — a 1px hairline inset top/bottom
  // between the segments (self-stretch inside the items-stretch cluster).
  // R126-3f-2: the hairline rides the bg-line CSS-var leg.
  const actionDivider = (
    <span className="w-px my-[3px] shrink-0 bg-line" aria-hidden />
  );
  // R91-C: the STAT FACTS — only the CONFIGURED ones (null = unknown =
  // absent). The section's shape follows the count (the owner: "If nothing
  // is added … it would not show the whole complete section at all. If only
  // a few things are added … the context would show on the right side of
  // the model ID itself"): 0 → nothing; a few → compact chips beside the
  // model id; most → the full details band.
  const statFacts: Array<{ label: string; value: string; short: string }> = [];
  if (m.contextWindow !== null) {
    statFacts.push({ label: "Context", value: formatTokenCount(m.contextWindow), short: `${formatTokenCount(m.contextWindow)} ctx` });
  }
  if (m.inputPricePerMtok !== null) {
    statFacts.push({ label: "Input", value: `$${m.inputPricePerMtok}/M`, short: `$${m.inputPricePerMtok} in` });
  }
  if (m.outputPricePerMtok !== null) {
    statFacts.push({ label: "Output", value: `$${m.outputPricePerMtok}/M`, short: `$${m.outputPricePerMtok} out` });
  }
  if (m.inputPriceCachedPerMtok !== null) {
    statFacts.push({ label: "Cache read", value: `$${m.inputPriceCachedPerMtok}/M`, short: `$${m.inputPriceCachedPerMtok} cache` });
  }

  return (
    <div className="flex flex-col">
      {/* ── R90-A2: THE MODEL SECTION — ONE highlighted card. Pre-R90 the
          details strip was its own bordered band floating 1.5px under the
          main row (the owner: "there was clear separation between the two…
          the model details should be in a single highlighted section").
          Now ONE border, ONE background: the identity row on top, the stats
          band fused underneath, separated only by a hairline. The test
          section (below) stays a SIBLING of this merged section — it is a
          transient result, not model identity. R126-3f-2: the catalog row =
          FLAT + the clay-rim hairline (TOKENS §5; the 1.5px border + the
          neutral-overlay fill are retired — the recess lives in the action
          group's well now), the accent edge still marks the unconfigured
          row. */}
      <div
        className={`rounded-xl border overflow-hidden ${
          m.configured ? "border-clay-rim" : "border-accent"
        }`}
      >
      {/* ── the identity row (the "top half" — stays exactly as it is when
          the test section expands below). R91-C (the owner: "The inputs
          which the model supports should be shown on the right side of the
          model name"): the capability ICON chips moved from their own row
          BELOW the name to INLINE on the name's RIGHT — one glance row:
          name · badges · [in] → [out]. At tight widths the flex-wrap keeps
          the chips on their own line automatically. ── */}
      <div className="px-4 py-3 flex flex-wrap items-center gap-3">
        {/* LEFT: identity — name, badges, capability ICON chips (right of
            the name), the id + the FEW-STATS chips on its row */}
        <div className="min-w-0 flex-1 flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
            <span
              className="truncate text-[13px] font-medium"
              style={{ color: m.configured ? styles.text : styles.textSecondary }}
              title={m.modelId}
            >
              {m.displayName || cleanModelName(m.modelId)}
            </span>
            {isFreeModelEntry(m) && (
              <span
                className="shrink-0 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-badge-success text-badge-success-fg"
              >
                FREE
              </span>
            )}
            {m.hidden && (
              <span
                className="shrink-0 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-badge-neutral text-badge-neutral-fg"
                title="Hidden from the chat model picker (still visible here)"
              >
                HIDDEN
              </span>
            )}
            {m.configured && m.sizeLabel !== null && m.sizeLabel !== "" && (
              <span
                className="shrink-0 px-1.5 py-0.5 rounded-full text-[10px] font-medium font-mono bg-badge-neutral text-badge-neutral-fg"
              >
                {m.sizeLabel}
              </span>
            )}
            {/* the capability ICON chips (R89-C3 → R90-A2 → R91-C: colored SVG
                badges, ICON-ONLY, INLINE on the name's right — the owner:
                "only show the images, the SVG logos"; the label survives as
                the tooltip + aria-label), IN group, then the ARROW (the
                transformation reads visually), then the OUT group. */}
            {m.configured && inChips.length > 0 && outChips.length > 0 && (
              <span className="shrink-0 inline-flex items-center gap-1 min-w-0 flex-wrap" aria-label="Input capabilities">
                {inChips.map((chip) => (
                  <span
                    key={`in:${chip.label}`}
                    className="shrink-0 inline-grid place-items-center h-5 w-5 rounded-lg"
                    style={{ background: withAlpha(chip.color, 0.13), color: chip.color }}
                    title={chip.title}
                    role="img"
                    aria-label={chip.title}
                  >
                    <chip.Icon size={11} strokeWidth={2.4} aria-hidden />
                  </span>
                ))}
                <span
                  className="shrink-0 mx-0.5 inline-grid place-items-center"
                  title="inputs → outputs"
                  aria-hidden
                >
                  <ArrowRight
                    size={12}
                    strokeWidth={2.5}
                    style={{ color: withAlpha(styles.textSecondary, 0.65) }}
                  />
                </span>
                {outChips.map((chip) => (
                  <span
                    key={`out:${chip.label}`}
                    className="shrink-0 inline-grid place-items-center h-5 w-5 rounded-lg"
                    style={{
                      background: withAlpha(chip.color, 0.09),
                      color: withAlpha(chip.color, 0.95),
                      boxShadow: `inset 0 0 0 1px ${withAlpha(chip.color, 0.3)}`,
                    }}
                    title={chip.title}
                    role="img"
                    aria-label={chip.title}
                  >
                    <chip.Icon size={11} strokeWidth={2.4} aria-hidden />
                  </span>
                ))}
              </span>
            )}
          </div>
          {/* the model id + (R91-C) the FEW-STATS chips on its right — when
              only one or two stats are configured they ride INLINE here
              (compact mono chips) instead of the full details band below. */}
          <div className="flex items-center gap-2 min-w-0 flex-wrap">
            <span className="truncate font-mono text-[10px]" style={{ color: styles.textTertiary }} title={m.modelId}>
              {m.modelId}
            </span>
            {m.configured && statFacts.length > 0 && statFacts.length <= 2 && (
              <span className="flex items-center gap-1.5 min-w-0 flex-wrap" data-testid="model-inline-stats">
                {statFacts.map((fact) => (
                  <span
                    key={fact.label}
                    className="shrink-0 px-1.5 py-0.5 rounded-full font-mono text-[10px] font-medium tabular-nums bg-badge-neutral text-badge-neutral-fg"
                    title={`${fact.label}: ${fact.value}`}
                  >
                    {fact.short}
                  </span>
                ))}
              </span>
            )}
          </div>
        </div>

        {/* RIGHT: the actions — R94-C: the owner's "cleaner UI, like an
            actual button kind of interface". The R87 icon trio + the R93-A7
            hide/show toggle are now ONE segmented ACTION GROUP: a shared
            rounded container with a hairline border + a recessed fill, a
            divider between the buttons, a pressed scale, and a focus-visible
            ring. R100-E2: the three JS hover pairs retired — each segment
            gets the standard hover:bg-hover CSS wash (TOKENS.md §6) and the
            destructive delete RESTS in the danger color (the R100-D
            WorkingSection idiom) instead of turning red on hover.
            R126-3f-2: the cluster's recess = THE WELL + the clay rim
            (TOKENS §10 — the 2% subtle fill + the withAlpha border are
            retired); the hidden-eye's accent tier moved to accentDeep.
            The Test segment keeps the R87 spin/pass/fail tint contract; the
            Eye keeps its accent-when-hidden state; every aria-label,
            title and data-testid is unchanged. */}
        {m.configured && row !== null && (
          <div
            className="inline-flex items-stretch rounded-lg border border-clay-rim bg-well shrink-0 overflow-hidden"
          >
            <TestIconButton model={row} state={state} run={runManual} variant="segment" />
            {actionDivider}
            <button
              onClick={onEdit}
              aria-label={`Configure model ${m.displayName || m.modelId}`}
              title="Configure — display name, capabilities, pricing, limits"
              className="h-8 w-8 grid place-items-center shrink-0 transition-all duration-200 hover:bg-hover active:scale-[0.92] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--ac-accent)]"
              style={{ color: styles.textSecondary }}
            >
              <Pencil size={13} />
            </button>
            {onToggleHidden !== undefined && (
              <>
                {actionDivider}
                <button
                  onClick={onToggleHidden}
                  aria-label={row.hidden ? `Show model ${m.displayName || m.modelId} in the chat picker` : `Hide model ${m.displayName || m.modelId} from the chat picker`}
                  title={row.hidden ? "Hidden from the chat picker — click to show" : "Shown in the chat picker — click to hide"}
                  data-testid="model-toggle-hidden"
                  className="h-8 w-8 grid place-items-center shrink-0 transition-all duration-200 hover:bg-hover active:scale-[0.92] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--ac-accent)]"
                  style={{ color: row.hidden ? styles.accentDeep : styles.textSecondary }}
                >
                  {row.hidden ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
              </>
            )}
            {actionDivider}
            <button
              onClick={onDelete}
              aria-label={`Delete model ${m.displayName || m.modelId}`}
              title="Delete this model"
              className="h-8 w-8 grid place-items-center shrink-0 transition-all duration-200 hover:bg-hover active:scale-[0.92] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--ac-accent)] text-danger-deep"
            >
              <Trash2 size={13} />
            </button>
          </div>
        )}
      </div>

      {/* ── R91-C: the DETAILS BAND — conditional. The owner: "If nothing is
          added (for example, no context is added, no input prices are added,
          no output is added, or no cache is routed), then it would not show
          the whole complete section at all." statFacts counts the CONFIGURED
          values: 0 → no band; 1–2 → the compact chips beside the model id
          (rendered in the identity row above) and NO band; 3+ → the full
          fused band (only the CONFIGURED cells — no "—" placeholders, the
          honest "what is set is what you see"). One border, one background
          with the identity row; a hairline separates them (R90-A2). */}
      {statFacts.length >= 3 ? (
        <div
          className="grid grid-cols-2 min-[420px]:grid-cols-4 border-t border-clay-rim"
          data-testid="model-details-band"
        >
          {statFacts.map((fact, i) => (
            <div
              key={fact.label}
              className={`px-3 py-1.5 flex flex-col gap-0 ${i > 0 ? "border-l border-clay-rim" : ""}`}
            >
              <span className="text-[10px] font-medium uppercase tracking-widest tabular-nums" style={{ color: styles.textTertiary }}>
                {fact.label}
              </span>
              <span className="font-mono text-[11px] font-medium tabular-nums" style={{ color: styles.text }}>
                {fact.value}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      </div>
      {/* ── end of the merged model section (R90-A2) ── */}

      {/* ── the TEST SECTION (R89-C6) — the dedicated expansion below the
          card: the top half stays untouched, the details get their own
          bordered band. R118-F: the band renders WHILE TESTING (the one-line
          "Testing {model}…" busy row — the old busy cue was a 12px spinner
          buried in a 32px icon-only button); a PASS folds at 10s (was 5s);
          a FAIL persists; interacting with a PASS band keeps it. */}
      <AnimatePresence>
        {(state.kind === "testing" || (showResult && (state.kind === "pass" || state.kind === "fail"))) && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.22, ease }}
            className="overflow-hidden"
            data-testid="model-test-result"
            data-model-test={state.kind}
          >
            {state.kind === "testing" ? (
              /* R126-3f-2: the TESTING band = the running badge tone
                 (TOKENS §11) — the R118-F "shows while testing" contract
                 byte-identical, only the material moved. */
              <div
                className="mt-1.5 rounded-xl px-3.5 py-2.5 flex items-center gap-2 text-[11px] bg-badge-running text-badge-running-fg"
                data-testid="model-test-busy"
              >
                <RefreshCw size={12} className="animate-spin" aria-hidden />
                Testing {m.displayName || m.modelId}…
              </div>
            ) : state.kind === "pass" ? (
              /* R126-3f-2: the PASS band = the success badge tone (TOKENS §11;
                 the 1.5px success border + the 0.05 wash are retired) — the
                 R118-F 10s fold byte-identical. */
              <div
                className="mt-1.5 rounded-xl px-3.5 py-2.5 flex flex-col gap-1.5 bg-badge-success text-badge-success-fg"
              >
                <div className="flex items-center gap-2.5 flex-wrap text-[11px]">
                  <span
                    className="inline-flex items-center gap-1.5 font-medium"
                  >
                    <Check size={12} strokeWidth={2.5} /> responded in {state.latencyMs}ms
                  </span>
                  {state.usage !== undefined && (
                    <span className="font-mono text-[11px]" style={{ color: styles.textTertiary }}>
                      {state.usage.inputTokens} tokens in / {state.usage.outputTokens} out
                    </span>
                  )}
                  <span className="flex-1" />
                  {state.preview !== undefined && (
                    <button
                      onClick={() => {
                        keepOpen();
                        setShowReply(!showReply);
                      }}
                      className="text-[11px] font-medium underline underline-offset-2"
                      style={{ color: styles.textSecondary }}
                      data-testid="model-test-show-reply"
                    >
                      {showReply ? "Hide reply" : "Show reply"}
                    </button>
                  )}
                </div>
                {/* R119-P — the tools leg: ONE line, the band's own 11px
                    typography; success when the model CALLED echo, warning
                    when it answered in text instead (a chat-only model —
                    the honest caution the old probe could never surface). */}
                {toolsLine !== null ? (
                  <div
                    className="text-[11px] font-medium"
                    style={{ color: toolsColor }}
                    data-testid="model-test-tools"
                  >
                    {toolsLine}
                  </div>
                ) : null}
                {showReply && state.preview !== undefined && (
                  <div
                    className="font-mono text-[11px] break-all rounded-lg px-2.5 py-1.5 max-h-28 overflow-y-auto auto-scroll bg-well border border-clay-rim"
                    style={{ color: styles.textSecondary }}
                    data-testid="model-test-reply-body"
                  >
                    {state.preview}
                  </div>
                )}
              </div>
            ) : (
              /* R126-3f-2: the FAIL band = the danger badge tone (TOKENS §11)
                 — the R118-F/R124 persistence byte-identical. */
              <div
                className="mt-1.5 rounded-xl px-3.5 py-2.5 flex flex-col gap-1.5 bg-badge-danger text-badge-danger-fg"
              >
                <div className="flex items-center gap-1.5 text-[11px] font-medium">
                  <AlertTriangle size={12} /> the test request failed
                </div>
                {/* R119-P — the tools rejection named distinctly: the reason
                    below carries the provider's full raw body; this line is
                    the scannable "the AGENT path is dead" verdict (THE
                    TokenHarbor shape). */}
                {toolsLine !== null ? (
                  <div
                    className="text-[11px] font-medium"
                    style={{ color: toolsColor }}
                    data-testid="model-test-tools"
                  >
                    {toolsLine}
                  </div>
                ) : null}
                <div className="text-[11px] break-all" style={{ color: styles.textSecondary }} data-testid="model-test-reason">
                  {showFull ? state.reason : `${state.reason.slice(0, 300)}${state.reason.length > 300 ? "…" : ""}`}
                </div>
                {state.reason.length > 300 && (
                  <button
                    onClick={() => {
                      keepOpen();
                      setShowFull(!showFull);
                    }}
                    className="text-[11px] font-medium underline underline-offset-2 self-start"
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
    </div>
  );
}

/** R94-C: the Test-All scope — "all" (every configured row), "failed" /
 * "working" (only rows whose LAST recorded outcome matches). */
type TestScope = "all" | "failed" | "working";

/** R94-C: the Test-scope menu's dismissal — outside mousedown, Escape, and
 * any scroll/resize (the menu is position:fixed, so a scrolled pane would
 * orphan it). The returned ref goes on the wrapper that contains BOTH the
 * trigger and the menu, so a click on the trigger toggles instead of
 * dismissing-then-reopening. Same shape as the composer's useDismiss —
 * replicated here because this file owns its own helpers. */
function useMenuDismiss(open: boolean, onDismiss: () => void): RefObject<HTMLDivElement> {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current !== null && !ref.current.contains(e.target as Node)) onDismiss();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onDismiss();
    };
    const onAnyScroll = (): void => onDismiss();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onAnyScroll, true);
    window.addEventListener("resize", onAnyScroll);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onAnyScroll, true);
      window.removeEventListener("resize", onAnyScroll);
    };
  }, [open, onDismiss]);
  return ref;
}

/** R94-C → R95-A: one option of the Test-scope ROW — the owner's directive:
 * "When I click the test button above it, it should show me three options
 * in a single row. The options should be properly formatted, well spaced,
 * and well separated from each other by lines." Each option is a compact
 * icon + label button that flexes to share the row evenly (the vertical
 * dividers live between them in the menu container); the honest disabled
 * state (opacity + cursor + the explanatory hint as the title) carries over
 * from the R94-C vertical menu verbatim. */
function ScopeOptionButton({
  testId,
  icon,
  label,
  hint,
  disabled,
  title,
  onClick,
}: {
  testId: string;
  icon: LucideIcon;
  label: string;
  /** The R94-C explanatory line — surfaced as the title tooltip (the
   * horizontal row has no room for a second text line). */
  hint: string;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
}) {
  const styles = useThemeStyles();
  const Icon = icon;
  return (
    <button
      type="button"
      role="menuitem"
      data-testid={testId}
      disabled={disabled}
      title={title ?? hint}
      onClick={onClick}
      className="flex-1 min-w-0 flex items-center justify-center gap-1.5 px-2 py-2 rounded-lg transition-colors enabled:hover:bg-hover disabled:cursor-default disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--ac-accent)]"
      style={{ color: disabled ? styles.textTertiary : styles.text }}
    >
      <Icon
        size={13}
        className="shrink-0"
        style={{ color: disabled ? styles.textTertiary : styles.accentDeep }}
      />
      <span className="text-[11px] font-medium leading-tight whitespace-nowrap">{label}</span>
    </button>
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
  // ROUND-124 (the owner: "it is showing me the Configure Model menu, but
  // the model has already been added"): a SINGLE Add is CONFIGURE-FIRST —
  // the ADD-mode config dialog opens on the prefill (static catalog + the
  // live entry's details + the smart blank-fill inside the dialog), and
  // SAVE creates the row; cancel adds nothing. The batch strip keeps the
  // direct add with its per-model fetch visibility.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [configuring, setConfiguring] = useState<ProviderModelConfig | null>(null);
  /** R124: the ADD-mode config dialog's prefill (configure-first — the
   * single Add hands its prefill here instead of upserting the row). */
  const [configuringPrefill, setConfiguringPrefill] = useState<ModelAddPrefill | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** ROUND-95 (R95-A): the model row whose delete is awaiting the styled
   * ConfirmDialog (the browser window.confirm is retired app-wide). */
  const [pendingDeleteModel, setPendingDeleteModel] = useState<MergedModel | null>(null);

  // ── R93-A7 → R94-C: the Test-All driver + progress + SCOPE. Each card owns
  // its test state (useModelTest) — the header bumps a seq and counts the
  // cards' settled reports. `done === total && total > 0` = finished; failed
  // > 0 colors the summary red. A models ROW-SET change (add/delete) RESETS
  // the progress so a stale counter can never stick to the new list — but a
  // per-row flip (the R94-C optimistic hidden toggle) must NOT reset it: it
  // re-renders `models` without changing the row set, and the reset would
  // also throw away the running summary. ─────────────────────────────────
  const [testAll, setTestAll] = useState<{ seq: number; total: number; done: number; failed: number; scope: TestScope } | null>(null);
  /** R94-C: the LAST test outcome per row (rowId → pass/fail) — the
   * Test-scope dropdown's memory. Filled as tests run: bulk pulses AND
   * manual row-button clicks both report through the card channel; entries
   * for rows that later leave the list simply stop matching. */
  const [lastResults, setLastResults] = useState<Map<string, "pass" | "fail">>(new Map());
  const modelIdsKey = models.map((m) => m.id).join("\u0000");
  useEffect(() => {
    setTestAll(null);
  }, [modelIdsKey]);

  // ROUND-60 (R60-B): the list shows CONFIGURED (stored) rows ONLY — the
  // R58/R50 catalog→list merge is GONE (the owner: "By default none of the
  // models should be added there… By default there should not be the free
  // models or all models there at all. I should be able to manually add
  // the models and only after that they will be shown there"). The live
  // catalog feeds the "Add models" picker ALONE — catalogIds is [] by
  // design; the static catalog stays a param for the picker pre-fill.
  const merged = mergeCatalogIntoModels(models, [], staticCatalog);

  // ── ROUND-95 (R95-A, the owner: "The models which are not hidden should
  // show at the very top and the models which are hidden actually should
  // show at the very bottom"): the render order is NOT-hidden first, hidden
  // last — derived from the CACHED rows on every render, so the R94-C
  // optimistic hidden-toggle flip re-sorts the list LIVE (the toggle patches
  // the query cache without a refetch; this derivation reads it). The
  // relative order inside each group is the query's own (stable). The cards
  // below render through a framer-motion `layout` wrapper, so a row GLIDES
  // to its new position instead of teleporting — and because a pure reorder
  // neither adds nor removes content, the detail pane's scrollTop holds.
  const orderedModels = [...merged.filter((m) => !m.hidden), ...merged.filter((m) => m.hidden)];

  /** R94-C: does this row belong to a test scope? "all" = every configured
   * row; "failed"/"working" = only rows whose LAST recorded outcome matches
   * (models never tested count in "all" only). */
  const inTestScope = (m: MergedModel, scope: TestScope): boolean =>
    m.configured &&
    m.rowId !== null &&
    (scope === "all" || lastResults.get(m.rowId) === (scope === "failed" ? "fail" : "pass"));
  const triggerTestAll = (scope: TestScope = "all"): void => {
    const total = merged.filter((m) => inTestScope(m, scope)).length;
    if (total === 0) return;
    setTestAll({ seq: (testAll?.seq ?? 0) + 1, total, done: 0, failed: 0, scope });
  };
  const onTestAllResult = useCallback((seq: number | null, ok: boolean, rowId: string | null) => {
    if (rowId !== null) {
      setLastResults((prev) => {
        if (prev.get(rowId) === (ok ? "pass" : "fail")) return prev;
        const next = new Map(prev);
        next.set(rowId, ok ? "pass" : "fail");
        return next;
      });
    }
    // A manual row click (seq null) feeds the scope map ONLY — it never
    // touches the bulk run's counter.
    if (seq === null) return;
    setTestAll((prev) =>
      prev !== null && prev.seq === seq
        ? { ...prev, done: prev.done + 1, failed: prev.failed + (ok ? 0 : 1) }
        : prev,
    );
  }, []);

  // ── R94-C: the scope menu (R95-A: the Test button's picker). The menu is
  // position:fixed off the trigger's rect — the section card's
  // overflow-hidden + the scrollable detail pane would clip an in-flow
  // absolute dropdown. R95-A: the menu is a SINGLE HORIZONTAL ROW now
  // (Test All | Test Only Failed | Test Only Working), so the estimate is
  // wide + short instead of the old tall vertical stack.
  const [scopeMenu, setScopeMenu] = useState<{ top: number; left: number } | null>(null);
  const closeScopeMenu = useCallback((): void => setScopeMenu(null), []);
  const scopeSplitRef = useMenuDismiss(scopeMenu !== null, closeScopeMenu);
  const toggleScopeMenu = (): void => {
    if (scopeMenu !== null) {
      setScopeMenu(null);
      return;
    }
    const el = scopeSplitRef.current;
    if (el === null) return;
    const rect = el.getBoundingClientRect();
    const width = 470;
    const estHeight = 68;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    const roomBelow = window.innerHeight - rect.bottom;
    setScopeMenu({
      top: roomBelow >= estHeight + 12 ? rect.bottom + 6 : Math.max(8, rect.top - estHeight - 6),
      left,
    });
  };
  const runScope = (scope: TestScope): void => {
    setScopeMenu(null);
    triggerTestAll(scope);
  };
  const testRunActive = testAll !== null && testAll.done < testAll.total;
  let failedCount = 0;
  let workingCount = 0;
  for (const m of merged) {
    if (!m.configured || m.rowId === null) continue;
    const r = lastResults.get(m.rowId);
    if (r === "fail") failedCount += 1;
    else if (r === "pass") workingCount += 1;
  }

  // ROUND-62 (R62-2b): model-config mutations fan out to the session
  // page's ["provider-models-config"] family (the rename/hide/pricing
  // staleness fix) — the helper keeps the settings-side invalidation.
  const invalidate = () => invalidateModelConfigEverywhere(queryClient, providerId);

  const deleteModel = useMutation({
    mutationFn: (id: string) => deleteProviderModelConfig(id),
    onSuccess: invalidate,
    onError: (err: Error) => setError(err.message),
  });

  // R93-A7 → R94-C: the hide/show quick toggle — now OPTIMISTIC. The old
  // path (PATCH → invalidate → refetch) reset the detail pane's scroll to
  // the top on every flip; now onMutate snapshots + patches the list's
  // query cache so the row turns over INSTANTLY and the list NEVER
  // refetches on this mutation (the patch is exactly {hidden}, so the
  // optimistic row is the server's answer too — onSuccess merges the
  // returned row in, still without a refetch). Only the CHAT PICKER's
  // families are invalidated: they are not mounted here, so their
  // background refetch can never flash or reset this pane.
  const toggleHidden = useMutation({
    mutationFn: (input: { rowId: string; hidden: boolean }) =>
      updateProviderModelConfig(input.rowId, { hidden: input.hidden }),
    onMutate: async (input: { rowId: string; hidden: boolean }) => {
      await queryClient.cancelQueries({ queryKey: ["settings-provider-models", providerId] });
      const snapshot =
        queryClient.getQueryData<ProviderModelConfig[]>(["settings-provider-models", providerId]) ?? null;
      queryClient.setQueryData<ProviderModelConfig[]>(["settings-provider-models", providerId], (rows) =>
        rows === undefined ? undefined : rows.map((r) => (r.id === input.rowId ? { ...r, hidden: input.hidden } : r)),
      );
      return { snapshot };
    },
    onError: (err: Error, _input: { rowId: string; hidden: boolean }, context: { snapshot: ProviderModelConfig[] | null } | undefined) => {
      if (context?.snapshot != null) {
        queryClient.setQueryData(["settings-provider-models", providerId], context.snapshot);
      }
      setError(err.message);
    },
    onSuccess: (row: ProviderModelConfig) => {
      queryClient.setQueryData<ProviderModelConfig[]>(["settings-provider-models", providerId], (rows) =>
        rows === undefined ? [row] : rows.map((r) => (r.id === row.id ? { ...r, ...row } : r)),
      );
      void queryClient.invalidateQueries({ queryKey: ["provider-models-config"] });
      void queryClient.invalidateQueries({ queryKey: ["models-configured"] });
    },
  });

  return (
    /* R100-E2: the SectionCard primitive with p-0 — the section header and
       the model rows own their own padding. R126-3f-2: the primitive now
       carries the clay card (3f-1) — free. */
    <SectionCard className="overflow-hidden p-0">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-line flex-wrap">
        <SectionLabel>Models</SectionLabel>
        {/* ROUND-60 (R60-B): the count is the CONFIGURED row count only —
            catalog entries are picker-only now (the free/all scope moved
            into the picker as the Free only ↔ All models toggle). */}
        <span data-testid="models-count" className="font-mono text-[10px]" style={{ color: styles.textTertiary }}>
          {merged.length}
        </span>
        {/* ── R93-A7 → R94-C → R95-A: the Test button (the owner: "that button
            should not say 'Test All' but it should only say 'Test'. When I
            click the test button above it, it should show me three options in
            a single row"). ONE button labeled "Test" at rest — the progress
            ("Testing X/Y…") and the pass/fail summary states ride the same
            node while a run settles. The click opens the SCOPE ROW: three
            options in ONE horizontal row, separated by divider lines —
            [ Test All | Test Only Failed | Test Only Working ]. The menu is
            fixed-position (see the comment at scopeMenu above) and rides the
            same wrapper for the outside-click dismissal. */}
        {merged.length > 0 ? (
          <div
            ref={scopeSplitRef}
            data-testid="test-scope-toggle"
            className="relative flex items-stretch shrink-0"
            onClick={(e) => {
              // The WRAPPER carries the toggle testid — only direct clicks on
              // it (not the button/menu children bubbling up) toggle here;
              // the button's own handler covers the rest.
              if (e.target === e.currentTarget) toggleScopeMenu();
            }}
          >
            <button
              onClick={toggleScopeMenu}
              disabled={testRunActive}
              aria-haspopup="menu"
              aria-expanded={scopeMenu !== null}
              data-testid="test-all-models"
              /* R126-3f-2: the Test pill rides the §11 tone containers on
                 the class leg — RUNNING while a run settles (the running
                 tone + the spinner), the settled summary in the success /
                 danger tones, the rest in the accent-tint/accentDeep pair;
                 the withAlpha fill + the JS color ladder are retired (the
                 R94-C/R95-A progress + summary contract byte-identical). */
              className={`h-7 px-2.5 rounded-full text-[11px] font-semibold flex items-center gap-1.5 disabled:cursor-default transition-colors duration-300 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--ac-accent)] cursor-pointer ${
                testRunActive
                  ? "bg-badge-running text-badge-running-fg"
                  : testAll !== null
                    ? testAll.failed > 0
                      ? "bg-badge-danger text-badge-danger-fg"
                      : "bg-badge-success text-badge-success-fg"
                    : "bg-accent-tint text-accent-deep"
              }`}
              title="Test — all models, only the failed ones, or only the working ones"
            >
              {testRunActive ? (
                <RefreshCw size={11} className="animate-spin" />
              ) : (
                <Zap size={11} strokeWidth={2.5} />
              )}
              {testAll === null
                ? "Test"
                : testRunActive
                  ? `Testing ${testAll.done}/${testAll.total}${testAll.scope === "failed" ? " failed" : testAll.scope === "working" ? " working" : ""}…`
                  : testAll.failed > 0
                    ? testAll.scope === "failed"
                      ? `${testAll.failed} of ${testAll.total} still failing`
                      : `${testAll.failed} of ${testAll.total} failed`
                    : testAll.scope === "failed"
                      ? `All ${testAll.total} now pass`
                      : testAll.scope === "working"
                        ? `All ${testAll.total} still pass`
                        : `All ${testAll.total} passed`}
            </button>
            {scopeMenu !== null && (
              <div
                role="menu"
                aria-label="Test scope"
                /* R126-3f-2: the anchored menu = the clay card (the
                   ModelSelector flyout spelling — border-clay-rim + bg-card
                   + .ac-clay-sm); the 1.5px border + the softShadow leg
                   are retired, the fixed top/left positioning stays. */
                className="ac-clay-sm fixed z-50 w-[470px] rounded-xl border border-clay-rim bg-card p-1.5 flex items-stretch"
                style={{
                  top: scopeMenu.top,
                  left: scopeMenu.left,
                }}
                onKeyDown={(e) => {
                  // R94-C → R95-A: the keyboard ladder — now HORIZONTAL
                  // (ArrowLeft/Right move the focus through the ENABLED
                  // items; Enter is the buttons' native activation; Escape
                  // rides the document listener).
                  const items = Array.from(
                    e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not([disabled])"),
                  );
                  if (items.length === 0) return;
                  const idx = items.indexOf(document.activeElement as HTMLButtonElement);
                  if (e.key === "ArrowRight") {
                    e.preventDefault();
                    items[(idx + 1) % items.length]!.focus();
                  } else if (e.key === "ArrowLeft") {
                    e.preventDefault();
                    items[(idx - 1 + items.length) % items.length]!.focus();
                  } else if (e.key === "Home") {
                    e.preventDefault();
                    items[0]!.focus();
                  } else if (e.key === "End") {
                    e.preventDefault();
                    items[items.length - 1]!.focus();
                  }
                }}
              >
                <ScopeOptionButton
                  testId="test-scope-all"
                  icon={Zap}
                  label="Test All"
                  hint={`Every model in this list (${merged.length})`}
                  disabled={testRunActive}
                  title={testRunActive ? "A test run is already in progress" : `Every model in this list (${merged.length})`}
                  onClick={() => runScope("all")}
                />
                <span
                  className="w-px my-1 shrink-0 bg-line"
                  aria-hidden
                />
                <ScopeOptionButton
                  testId="test-scope-failed"
                  icon={AlertTriangle}
                  label="Test Only Failed"
                  hint={
                    failedCount === 0
                      ? "No failures recorded yet"
                      : `Only the ${failedCount} model${failedCount === 1 ? "" : "s"} whose last test failed`
                  }
                  disabled={testRunActive || failedCount === 0}
                  title={
                    testRunActive
                      ? "A test run is already in progress"
                      : failedCount === 0
                        ? "No failed models yet — run Test All first"
                        : `Only the ${failedCount} model${failedCount === 1 ? "" : "s"} whose last test failed`
                  }
                  onClick={() => runScope("failed")}
                />
                <span
                  className="w-px my-1 shrink-0 bg-line"
                  aria-hidden
                />
                <ScopeOptionButton
                  testId="test-scope-working"
                  icon={Check}
                  label="Test Only Working"
                  hint={
                    workingCount === 0
                      ? "No passes recorded yet"
                      : `Only the ${workingCount} model${workingCount === 1 ? "" : "s"} whose last test passed`
                  }
                  disabled={testRunActive || workingCount === 0}
                  title={
                    testRunActive
                      ? "A test run is already in progress"
                      : workingCount === 0
                        ? "No working models yet — run Test All first"
                        : `Only the ${workingCount} model${workingCount === 1 ? "" : "s"} whose last test passed`
                  }
                  onClick={() => runScope("working")}
                />
              </div>
            )}
          </div>
        ) : null}
        <span className="flex-1" />
        {/* ROUND-50 (R50-d): "Add models" opens the catalog picker dialog
            (multi-select from the provider's live catalog, with a manual
            add-by-id fallback) — replacing the type-an-id inline form. */}
        <button
          onClick={() => setPickerOpen(true)}
          /* R126-3f-2: the quiet accent-tint action — the accent-tint
             container + accentDeep ink (TOKENS §1d/§10) + the press floor;
             the withAlpha fill + the JS accent color are retired. */
          className="h-7 px-2.5 rounded-full text-[11px] font-semibold flex items-center gap-1 bg-accent-tint text-accent-deep transition-transform active:scale-[0.98] cursor-pointer"
        >
          <Plus size={11} strokeWidth={2.5} /> Add models
        </button>
      </div>

      {error && (
        <div className="px-4 py-2 border-b border-line text-[11px] text-danger-deep">{error}</div>
      )}

      {/* ROUND-62 (R62-2b): the load error replaces the empty state — an
          unreachable models-config must never read as "no models added". */}
      {modelsLoadError !== null && (
        <div
          role="alert"
          className="px-4 py-3 text-[11px] text-danger-deep"
        >
          Couldn&apos;t load this provider&apos;s models — {modelsLoadError}
        </div>
      )}

      {modelsLoadError === null && merged.length === 0 ? (
        <div className="px-4 py-6 text-center text-[12px]" style={{ color: styles.textTertiary }}>
          No models yet — use “Add models” to pick from the provider's catalog.
        </div>
      ) : (
        /* ROUND-95 (R95-A, the owner: "add some proper separation between the
            models so that they are properly separated, look proper and good…
            the user can easily visually distinguish between the two models"):
            the gap grows 2.5 → 3 and each card renders through a
            framer-motion `layout` wrapper — together with the R95-A
            hidden-at-bottom ordering this is what makes a hidden toggle
            visibly GLIDE the row to its new slot. The rows render from
            `orderedModels` (not-hidden first, hidden last). */
        <div className="flex flex-col gap-3 p-3">
          {/* R89-C5/C6: every model renders through the ModelCard — the
              bordered card with the LEFT identity / RIGHT actions split,
              the DEDICATED details strip (context / input / output / cache
              read), the colored capability ICON chips, and the expanding
              TEST section below the card. */}
          {orderedModels.map((m) => (
            <motion.div
              key={m.rowId ?? `cat:${m.modelId}`}
              layout
              transition={{ type: "spring", stiffness: 420, damping: 38 }}
              className="flex flex-col min-w-0"
              data-hidden={m.hidden ? "true" : undefined}
            >
              <ModelCard
                m={m}
                row={models.find((r) => r.id === m.rowId) ?? null}
                onEdit={() => {
                  const row = models.find((r) => r.id === m.rowId);
                  if (row) setConfiguring(row);
                }}
                onDelete={() => {
                  // ROUND-95 (R95-A): the styled ConfirmDialog replaces the
                  // browser window.confirm (the owner's "properly formatted"
                  // popup ask) — the confirm itself fires the delete.
                  setPendingDeleteModel(m);
                }}
                onToggleHidden={
                  m.rowId !== undefined && m.configured
                    ? () => {
                        const row = models.find((r) => r.id === m.rowId);
                        if (row) toggleHidden.mutate({ rowId: row.id, hidden: !row.hidden });
                      }
                    : undefined
                }
                // R94-C: the scoped pulse — only IN-SCOPE cards receive the new
                // seq (the others keep undefined: their effect early-returns, so
                // a scope run never re-tests an out-of-scope model).
                testAllSeq={
                  testAll !== null && inTestScope(m, testAll.scope) ? testAll.seq : undefined
                }
                onTestAllResult={onTestAllResult}
              />
            </motion.div>
          ))}
        </div>
      )}

      {/* ROUND-95 (R95-A): the model-delete confirm — the card's trash opens
          the shared styled ConfirmDialog (window.confirm is retired). */}
      {pendingDeleteModel !== null && (
        <ConfirmDialog
          title="Delete model"
          message={`Do you want to delete "${pendingDeleteModel.displayName || pendingDeleteModel.modelId}" and its saved configuration?`}
          confirmLabel="Delete model"
          danger
          onConfirm={() => {
            if (pendingDeleteModel.rowId !== null) deleteModel.mutate(pendingDeleteModel.rowId);
            setPendingDeleteModel(null);
          }}
          onClose={() => setPendingDeleteModel(null)}
        />
      )}

      {/* ROUND-50 (R50-d): the catalog-driven picker + the per-model config
          dialog. Both invalidate THIS provider's models query on change.
          R93-A6: the batch strip (and the manual by-id form) adds DIRECTLY
          with the prefill as defaults.
          ROUND-124 (the owner: "it is showing me the Configure Model menu,
          but the model has already been added"): a SINGLE Add is
          CONFIGURE-FIRST again — the picker hands the prefill (static
          catalog + the live entry's details) here, the ADD-mode config
          dialog opens, and SAVE creates the row (cancel = nothing
          happened). The R95-A add-then-configure upsert is retired. */}
      {pickerOpen && (
        <AddModelsDialog
          providerId={providerId}
          catalog={catalog}
          staticCatalog={staticCatalog}
          configuredIds={new Set(models.map((m) => m.modelId))}
          onAddDirect={async (prefills) => {
            // R93-A6: upsert each prefill as a configured row with the
            // prefill as its defaults (the exact payload an untouched config
            // draft would POST). allSettled so a partial failure is REPORTED,
            // not swallowed.
            const results = await Promise.allSettled(
              prefills.map((p) =>
                upsertProviderModelConfig(providerId, {
                  modelId: p.modelId,
                  displayName: p.displayName,
                  contextWindow: p.contextWindow ?? null,
                  maxOutputTokens: p.maxOutputTokens ?? null,
                  inputPricePerMtok: p.inputPricePerMtok ?? null,
                  inputPriceCachedPerMtok: p.inputPriceCachedPerMtok ?? null,
                  outputPricePerMtok: p.outputPricePerMtok ?? null,
                  supportsVision: p.supportsVision,
                }),
              ),
            );
            const failed = results.filter((r) => r.status === "rejected") as Array<
              PromiseRejectedResult
            >;
            invalidate();
            if (failed.length > 0) {
              const first = failed[0]!.reason;
              const message = first instanceof Error ? first.message : String(first);
              throw new Error(
                `${failed.length} of ${prefills.length} add${failed.length === 1 ? "" : "s"} failed — ${message}`,
              );
            }
            return results.map((r) => (r.status === "fulfilled" ? r.value : null));
          }}
          onConfigurePrefill={(prefill) => {
            // R124: configure-first — the picker closes and the ADD-mode
            // config dialog opens on the prefill; Save POSTs the row.
            setPickerOpen(false);
            setConfiguringPrefill(prefill);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
      {configuring && (
        <ModelConfigDialog
          providerId={providerId}
          model={configuring}
          prefill={null}
          catalog={catalog}
          onClose={() => setConfiguring(null)}
          onSaved={() => {
            invalidate();
            setConfiguring(null);
          }}
        />
      )}
      {configuringPrefill && (
        <ModelConfigDialog
          providerId={providerId}
          model={null}
          prefill={configuringPrefill}
          catalog={catalog}
          onClose={() => setConfiguringPrefill(null)}
          onSaved={() => {
            invalidate();
            setConfiguringPrefill(null);
          }}
        />
      )}
    </SectionCard>
  );
}

/* ── ROUND-50 (R50-d): the "Add models" catalog picker dialog ─────────────── */

/**
 * R93-A6 → ROUND-95 → ROUND-124: the picker's TWO-way interaction (the
 * owner retired the third — "there should first of all not be the
 * configure button at all… the configuring should happen like this: when
 * the user clicks on the add button manually, it will add that model and
 * it will open up the configuring menu for that model"; R124 refined it
 * again — the Configure Model menu must open WITHOUT the model already
 * being added; Save is what adds it):
 *  · LEFT zone (checkbox + name): click = TOGGLE selection; press + DRAG
 *    across rows = paint-selection (every row swept joins the initial
 *    toggle's target state — selecting OR deselecting).
 *  · RIGHT zone (R124): "Add" = CONFIGURE-FIRST — the ADD-mode config
 *    dialog opens on the prefill (static catalog + the live entry's
 *    details); Save creates the row, cancel adds nothing. Already-added
 *    models are NOT SHOWN at all (R95-A: "The models which have already
 *    been added should not be shown in the add model popup").
 *  · Batch (R124): "Add N models" enriches every selected prefill with the
 *    live catalog's details — a fresh catalog read with per-row fetch
 *    visibility (spinner → "✓ live details" / "— no details served" chips,
 *    the owner's "show me some animations for them"), then the upserts,
 *    then a brief "Added N — M with live details" summary, then close.
 */
function AddModelsDialog({
  providerId,
  catalog,
  staticCatalog,
  configuredIds,
  onAddDirect,
  onConfigurePrefill,
  onClose,
}: {
  /** The provider being picked for (kept in the call-site shape for
   * symmetry with the sibling dialogs; the picker itself routes through
   * the parent's onAddDirect). */
  providerId: string;
  catalog: ProviderCatalogState;
  staticCatalog: CatalogModel[];
  configuredIds: Set<string>;
  /** R93-A6: DIRECT (batch) add — the parent upserts each prefill as a
   * configured row with the prefill as its defaults and invalidates;
   * resolves with the CREATED rows in order (a rejected entry never reaches
   * the success path — a failure rejects the whole call). Rejects with a
   * readable message on any failure (no silent partial success). */
  onAddDirect: (prefills: ModelAddPrefill[]) => Promise<(ProviderModelConfig | null)[]>;
  /** ROUND-124 (the owner's verdict: “it is showing me the Configure Model
   * menu, but the model has already been added” — dead): a SINGLE add no
   * longer upserts anything — the picker closes and the config dialog
   * opens in ADD mode carrying the prefill (save = create; cancel =
   * nothing happened). The R95-A add-then-configure handoff is retired. */
  onConfigurePrefill: (prefill: ModelAddPrefill) => void;
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

  // ── R93-A6: selection + drag-paint state ────────────────────────────────
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** The live paint session (null when the pointer is up): `target` is the
   * boolean every swept row joins — set at pointerdown from the initial
   * row's toggle, so a drag can paint selection OR deselection. */
  const paintRef = useRef<{ target: boolean } | null>(null);
  useEffect(() => {
    const stop = (): void => {
      paintRef.current = null;
    };
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, []);
  const toggleSelect = (id: string, target: boolean): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (target) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  // pointerdown on a row's LEFT zone: toggle that row AND open the paint
  // session in the toggled direction (a plain click = one-row paint).
  const beginPaint = (id: string): void => {
    const target = !selected.has(id);
    paintRef.current = { target };
    toggleSelect(id, target);
  };
  // pointerenter on a swept row's LEFT zone: join the paint's target state.
  const paintOver = (id: string): void => {
    const paint = paintRef.current;
    if (paint === null || selected.has(id) === paint.target) return;
    toggleSelect(id, paint.target);
  };
  const clearSelection = (): void => setSelected(new Set());
  const selectedCount = selected.size;

  // ── R93-A6 + R124: the direct-add/batch mutation, now with the ─────────
  //    per-model FETCH VISIBILITY the owner asked for (“if it cannot fetch
  //    the data of some models… show me some animations for them, so that I
  //    am aware of whether it even tried to fetch the data for it or not”).
  //    The pipeline: (1) the enrichment pass — ONE fresh catalog read
  //    (the same GET /providers/:id/models that loaded the picker; the
  //    backend's 5-minute cache makes a warm read instant) with a spinner
  //    on every selected row while it runs; (2) the per-row OUTCOME — a
  //    “live details” chip when the entry carried them, an honest “no
  //    details served” chip when it did not; (3) the upserts; (4) the
  //    summary line (“Added N — M with live details, K without”) holds
  //    briefly so the outcome is READ before the picker closes. ──────────
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  /** R124: per-row outcome during/after the enrichment pass —
   * "fetching" while the catalog read runs, "details" | "none" after it. */
  const [rowFetchState, setRowFetchState] = useState<Map<string, "fetching" | "details" | "none">>(new Map());
  /** R124: the post-success summary that holds the picker open briefly. */
  const [batchSummary, setBatchSummary] = useState<string | null>(null);
  const addSelected = async (): Promise<void> => {
    const ids: string[] = [];
    for (const id of selected) {
      if (!configuredIds.has(id)) ids.push(id);
    }
    if (ids.length === 0 || batchBusy) return;
    setBatchBusy(true);
    setBatchError(null);
    setBatchSummary(null);
    setRowFetchState(new Map(ids.map((id) => [id, "fetching"] as const)));
    try {
      // (1) the enrichment read — fresh through the queryClient so a warm
      // cache still tells the truth about the provider's CURRENT listing.
      let enriched = catalog.entries;
      try {
        enriched = await fetchProviderModelEntries(providerId);
      } catch {
        // The enrichment read failing does NOT fail the add — the prefills
        // fall back to what the picker already had, and every row's outcome
        // chip reads "none" (the honest “tried, got nothing”).
      }
      const enrichedById = new Map(enriched.map((e) => [e.id, e]));
      // (2) the per-row outcomes + the prefills that carry them.
      const prefills: ModelAddPrefill[] = [];
      let withDetails = 0;
      const outcomes = new Map<string, "details" | "none">();
      for (const id of ids) {
        const prefill = prefillFor(id, enrichedById.get(id));
        prefills.push(prefill);
        const hasLive = enrichedById.get(id)?.details !== undefined;
        outcomes.set(id, hasLive ? "details" : "none");
        if (hasLive) withDetails += 1;
      }
      setRowFetchState(outcomes);
      // (3) the upserts.
      await onAddDirect(prefills);
      // (4) the summary holds ~1.4s so the outcome is READ, then closes.
      setBatchSummary(
        ids.length === 1
          ? withDetails === 1
            ? "Added — live details fetched"
            : "Added — the provider served no details"
          : `Added ${ids.length} — ${withDetails} with live details, ${ids.length - withDetails} without`,
      );
      await new Promise((resolve) => setTimeout(resolve, 1400));
      onClose(); // batch success closes the picker (the rows are in the list)
    } catch (err) {
      setBatchError(err instanceof Error ? err.message : String(err));
    } finally {
      setBatchBusy(false);
    }
  };

  // ── ROUND-124 (the owner: “it is showing me the Configure Model menu, but
  //    the model has already been added”): the SINGLE add is now CONFIGURE
  //    FIRST — Add opens the config dialog in ADD mode carrying the prefill
  //    (static catalog + live details); SAVE creates the row, cancel changes
  //    nothing. Serves BOTH the row's right-zone Add button and the manual
  //    add-by-id footer. ──
  const addOne = (id: string): void => {
    if (batchBusy) return;
    onConfigurePrefill(prefillFor(id));
  };

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
  // ROUND-95 (R95-A, the owner: "The models which have already been added
  // should not be shown in the add model popup"): the search scope and the
  // free scope are kept as separate steps so the empty note below can tell
  // the three "nothing to show" causes apart (no search match / no free
  // match / every match already added). Never-added rows only, then the cap.
  const searchRows = catalog.entries.filter(
    (entry) =>
      q === "" ||
      entry.id.toLowerCase().includes(q) ||
      entry.name.toLowerCase().includes(q),
  );
  const scopeRows = searchRows.filter((entry) => {
    if (!freeOnly) return true;
    const meta = staticById.get(entry.id);
    return meta ? meta.free : isFreeModelEntry({ modelId: entry.id });
  });
  const rows = scopeRows.filter((entry) => !configuredIds.has(entry.id)).slice(0, 300); // sanity cap — the live OpenRouter catalog is huge

  /** ROUND-87 (R87) → R89-C2 → ROUND-124: the prefill a picked model hands
   * to the config dialog — a CLEAN human display name FIRST (the live
   * entry's name, then the served catalog's, then the last path segment
   * humanized — the owner: "the last part of the model ID was supposed to
   * be shown as the name"), then the static catalog's pricing/context/vision
   * knowledge, then — NEW this round — the LIVE entry's additive details
   * filling every gap the static catalog left (the mobile's R120-M smart
   * fetch, now on the desktop too: the owner: "on my mobile it does
   * pre-load the context window, max output, input-output prices… and
   * everything"). Only-blank policy: a static value is never overwritten
   * by a live one; vision is an OR (either source may assert it). The
   * `enrichedEntry` param is the BATCH pipeline's fresh entry — defaults
   * to the picker's own catalog entry. */
  const prefillFor = (id: string, enrichedEntry?: ProviderModelCatalogEntry): ModelAddPrefill => {
    const meta = staticById.get(id);
    const entry = enrichedEntry ?? catalog.entries.find((e) => e.id === id);
    const live = entry?.details;
    const num = (a: number | null | undefined, b?: number): number | null =>
      a !== null && a !== undefined ? a : (b ?? null);
    return {
      modelId: id,
      displayName:
        entry && entry.name !== "" && entry.name !== id
          ? entry.name
          : meta?.displayName ?? cleanModelName(id),
      contextWindow: num(meta?.contextWindow ?? null, live?.contextWindow),
      maxOutputTokens: num(meta?.maxOutputTokens ?? null, live?.maxOutputTokens),
      inputPricePerMtok: num(meta?.inputPricePerMtok ?? null, live?.inputPricePerMtok),
      inputPriceCachedPerMtok: num(
        meta?.inputPriceCachedPerMtok ?? null,
        live?.inputPriceCachedPerMtok,
      ),
      outputPricePerMtok: num(meta?.outputPricePerMtok ?? null, live?.outputPricePerMtok),
      supportsVision: (meta?.supportsVision ?? false) || (live?.supportsVision ?? false),
    };
  };

  // R126-3f-2: the picker's inputs ride the well + rim on the CSS-var leg
  // (TOKENS §10) — the shared `inputStyle` JS leg is retired.

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
        /* R126-3f-2: the DIALOG = the clay card (the AddProjectDialog
           spelling — rounded-xl + the 1px clay rim + .ac-clay; TOKENS §5/§9
           — the 1.5px border + the softShadow leg are retired). */
        className="ac-clay w-full max-w-[560px] max-h-[82vh] rounded-xl border flex flex-col overflow-hidden"
        style={{ background: styles.card, borderColor: styles.clayRim }}
      >
        {/* header */}
        <div className="flex items-center gap-2 px-5 pt-4 pb-3 shrink-0">
          <span className="text-[13px] font-semibold" style={{ color: styles.text }}>
            Add models
          </span>
          <span className="flex-1" />
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-7 h-7 grid place-items-center rounded-lg"
            style={{ color: styles.textTertiary }}
          >
            <X size={14} />
          </button>
        </div>
        <p className="px-5 pb-3 text-[11px] shrink-0" style={{ color: styles.textSecondary }}>
          Click <b>Add</b> on the right to add a model and open its configuration, or drag across
          rows on the left to select several at once. Already-added models are hidden.
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
              className="h-10 w-full rounded-xl border border-clay-rim bg-well pl-9 pr-3 text-[13px] text-ink outline-none"
            />
          </div>
          {/* Same segmented visual language the rest of the app uses
              (SubAgentsTab / ModelSelector) — ROUND-82: the toggle rides the
              dialog-LOCAL scope (auto-switches to All for zero-free catalogs;
              the shared pref is initialized from, never written to). */}
          <div
            role="group"
            aria-label="Catalog filter"
            /* R126-3f-2: the segmented control = the 1px clay rim + the
               accentTint/accentDeep ACTIVE segment (the ModelSelector
               Free/All spelling from 3d-4); the 1.5px bento border + the
               withAlpha fill are retired. */
            className="flex items-center rounded-xl border border-clay-rim overflow-hidden shrink-0"
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
                className={`h-10 px-2.5 text-[11px] font-medium transition-colors duration-100 whitespace-nowrap cursor-pointer ${
                  seg.active ? "bg-accent-tint text-accent-deep" : "text-muted hover:text-ink"
                }`}
              >
                {seg.label}
              </button>
            ))}
          </div>
        </div>

        {/* the catalog rows — R93-A6 → R95-A: the TWO-zone card (LEFT =
            select / drag-paint, RIGHT = Add + configure). Already-added rows
            are NOT rendered at all (filtered out of `rows` above). */}
        <div className="flex-1 min-h-0 overflow-y-auto auto-scroll px-3 pb-3 flex flex-col gap-1">
          {catalog.isFetching && catalog.entries.length === 0 && (
            <div className="px-2 py-4 text-[11px] flex items-center gap-2" style={{ color: styles.textTertiary }}>
              <RefreshCw size={12} className="animate-spin" /> Fetching the provider catalog…
            </div>
          )}
          {!catalog.isFetching && catalog.entries.length === 0 && (
            <div className="px-2 py-4 text-[11px]" style={{ color: styles.textTertiary }}>
              {catalog.isError
                ? "The live catalog is unreachable for this provider — add a model by id below."
                : "This provider serves no catalog — add a model by id below."}
            </div>
          )}
          {rows.map((entry) => {
            const meta = staticById.get(entry.id);
            const free = meta ? meta.free : isFreeModelEntry({ modelId: entry.id });
            const isSelected = selected.has(entry.id);
            // R89-C1 (the owner: "it should only show the model ID, the NAME
            // of the model [at the top] and below it the model ID"): the
            // title is the clean human NAME — the live entry's name, else
            // the last path segment humanized — NEVER the full id twice.
            const cleanName =
              entry.name !== "" && entry.name !== entry.id ? entry.name : cleanModelName(entry.id);
            return (
              <div
                key={entry.id}
                data-testid="picker-model-row"
                data-model-id={entry.id}
                data-selected={isSelected ? "true" : undefined}
                /* R126-3f-2: the catalog rows = FLAT + the clay-rim hairline
                   (TOKENS §5), the SELECTED row = the accentDeep tier
                   (border-accent-deep + bg-accent-tint — the brief's §5
                   selection spelling); the accent withAlpha borders + the
                   neutral overlay fills are retired. */
                className={`flex items-stretch gap-2 rounded-xl border transition-all ${
                  isSelected ? "border-accent-deep bg-accent-tint" : "border-clay-rim"
                }`}
              >
                {/* ── LEFT zone: the select checkbox + the text. PointerDOWN
                    toggles and opens the paint session; sweeping the pointer
                    across other rows' left zones paints them into the same
                    state (R93-A6). */}
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={isSelected}
                  aria-label={`Select ${cleanName} (${entry.id})`}
                  data-testid="picker-model-select"
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    beginPaint(entry.id);
                  }}
                  onPointerEnter={() => paintOver(entry.id)}
                  className="flex-1 min-w-0 flex items-center gap-3 px-3 py-2.5 text-left rounded-l-lg enabled:cursor-pointer disabled:cursor-default touch-none"
                  title={
                    isSelected
                      ? "Selected — drag across rows to select more"
                      : "Click or drag to select"
                  }
                >
                  <span
                    aria-hidden
                    data-testid="picker-model-checkbox"
                    /* R126-3f-2: the selected checkbox = the accentDeep
                       tier + the accentText ink (TOKENS §1d) on the class
                       leg; the 1.5px border is retired. */
                    className={`shrink-0 w-4.5 h-4.5 rounded-sm grid place-items-center border transition-colors ${
                      isSelected ? "border-accent-deep bg-accent-deep" : "border-clay-rim bg-transparent"
                    }`}
                  >
                    {isSelected ? <Check size={12} style={{ color: styles.accentText }} /> : null}
                  </span>
                  <span className="min-w-0 flex-1 flex flex-col gap-0.5">
                    <span className="flex items-center gap-1.5 min-w-0 flex-wrap">
                      <span
                        className="truncate text-[13px] font-medium"
                        style={{ color: styles.text }}
                      >
                        {cleanName}
                      </span>
                      {free ? (
                        <span
                          className="shrink-0 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-badge-success text-badge-success-fg"
                        >
                          FREE
                        </span>
                      ) : meta ? (
                        <span
                          className="shrink-0 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-badge-neutral text-badge-neutral-fg"
                        >
                          PAID
                        </span>
                      ) : null}
                    </span>
                    <span className="flex items-center gap-2 min-w-0 flex-wrap">
                      <span className="truncate font-mono text-[10px] tabular-nums" style={{ color: styles.textTertiary }}>
                        {entry.id}
                      </span>
                      {meta && (
                        <span className="shrink-0 font-mono text-[10px] tabular-nums" style={{ color: styles.textTertiary }}>
                          {formatPricingSummary(meta) ?? "pricing unknown"}
                          {meta.contextWindow > 0 ? ` · ${formatTokenCount(meta.contextWindow)}` : ""}
                        </span>
                      )}
                    </span>
                  </span>
                </button>
                {/* ── RIGHT zone: the SINGLE add (R124, configure-first — the
                    owner: "it is showing me the Configure Model menu, but
                    the model has already been added" — dead): Add opens the
                    ADD-mode config dialog carrying the prefill (static
                    catalog + the live entry's details); SAVE creates the
                    row, cancel adds nothing. Next to it, the R124 per-row
                    FETCH OUTCOME chip while/after a batch runs (the owner:
                    "show me some animations for them, so that I am aware
                    of whether it even tried to fetch the data"). ── */}
                {rowFetchState.get(entry.id) !== undefined ? (
                  <span
                    data-testid={`picker-row-fetch-${entry.id}`}
                    className="shrink-0 self-center flex items-center gap-1 font-mono text-[10px] mr-1"
                    style={{
                      color:
                        rowFetchState.get(entry.id) === "details"
                          ? styles.accentDeep
                          : styles.textTertiary,
                    }}
                  >
                    {rowFetchState.get(entry.id) === "fetching" ? (
                      <>
                        <RefreshCw size={10} className="animate-spin" aria-hidden />
                        fetching details…
                      </>
                    ) : rowFetchState.get(entry.id) === "details" ? (
                      <>✓ live details</>
                    ) : (
                      <>— no details served</>
                    )}
                  </span>
                ) : null}
                <button
                  type="button"
                  onClick={() => addOne(entry.id)}
                  disabled={batchBusy}
                  aria-label={`Add ${entry.id}`}
                  data-testid="picker-model-direct-add"
                  /* R126-3f-2: the quiet accent-tint action (TOKENS §1d/§10)
                     — the accent-tint container + the accentDeep ink on the
                     class leg; the accent-soft/faded pair + the JS accent
                     color are retired. */
                  className="shrink-0 self-center flex items-center gap-1 h-8 px-3 mr-2 rounded-full text-[11px] font-semibold transition-all duration-100 bg-accent-tint text-accent-deep hover:bg-hover active:scale-[0.97] disabled:opacity-50 cursor-pointer"
                  title="Configure this model before adding — Save creates it"
                >
                  <Plus size={12} /> Add
                </button>
              </div>
            );
          })}
          {rows.length === 0 && catalog.entries.length > 0 && (
            <div className="px-2 py-4 text-[11px]" style={{ color: styles.textTertiary }}>
              {/* ROUND-60 → R95-A: honest about ALL THREE filters — the search
                  text, the free-only scope, or "every match is already added"
                  may each have emptied the list (already-added rows are not
                  rendered at all anymore). */}
              {searchRows.length === 0
                ? `No catalog model matches “${query.trim()}” — add one by id below.`
                : scopeRows.length === 0
                  ? "No free models match — switch to “All models” or refine the search."
                  : scopeRows.every((entry) => configuredIds.has(entry.id))
                    ? "All matches are already added."
                    : "No addable models match — refine the search."}
            </div>
          )}
        </div>

        {/* ── R93-A6: the selection strip — the batch add affordance. Appears
            the moment any row is selected; rides BETWEEN the list and the
            manual footer so the muscle memory for both is stable. */}
        {selectedCount > 0 ? (
          <div
            data-testid="picker-batch-strip"
            /* R126-3f-2: the batch strip = the accent-tint footer zone on
               the CSS-var leg (the withAlpha 0.05 wash retired). */
            className="shrink-0 border-t border-line px-5 py-3 flex items-center gap-3 bg-accent-tint"
          >
            <span className="text-[12px] font-medium" style={{ color: styles.text }}>
              {selectedCount} model{selectedCount === 1 ? "" : "s"} selected
            </span>
            {/* R124: the post-add summary — what the enrichment pass GOT
                ("Added 3 — 2 with live details, 1 without"), held briefly
                so the outcome is READ before the picker closes. */}
            {batchSummary !== null ? (
              <span
                data-testid="picker-batch-summary"
                className="text-[11px] font-medium truncate"
                style={{ color: styles.textSecondary }}
              >
                {batchSummary}
              </span>
            ) : null}
            <span className="flex-1" />
            <button
              type="button"
              onClick={clearSelection}
              disabled={batchBusy}
              className="h-9 px-3.5 rounded-full text-[11px] font-semibold transition-colors duration-100 hover:bg-hover disabled:opacity-50 cursor-pointer"
              style={{ color: styles.textSecondary }}
            >
              Clear
            </button>
            <button
              type="button"
              onClick={() => void addSelected()}
              disabled={batchBusy}
              data-testid="picker-batch-add"
              /* R126-3f-2: the QUIET-SOLID clay primary (COMPONENTS §4) —
                 the accentDeep fill on the class leg + the accentText ink
                 on the JS leg, rounded-lg + the press collapse; the accent
                 fill + the pill radius are retired. */
              className="ac-clay-pressed h-9 px-4 rounded-lg text-[12px] font-semibold bg-accent-deep transition-transform active:scale-[0.98] disabled:opacity-50 flex items-center gap-1.5 cursor-pointer"
              style={{ color: styles.accentText }}
            >
              {batchBusy ? <RefreshCw size={12} className="animate-spin" /> : <Plus size={12} />}
              {batchBusy ? "Adding…" : `Add ${selectedCount} model${selectedCount === 1 ? "" : "s"}`}
            </button>
          </div>
        ) : null}

        {/* The honest failure surface (R93-B4: no silent adds) — any direct or
            batch add error lands HERE, names the failed count, and keeps the
            picker open for a retry. */}
        {batchError !== null ? (
          <div
            data-testid="picker-batch-error"
            className="shrink-0 border-t border-line px-5 py-3 flex items-center gap-2 text-[11px] font-medium text-danger-deep"
          >
            <AlertTriangle size={13} className="shrink-0" />
            <span className="min-w-0 flex-1">{batchError}</span>
            <button
              type="button"
              onClick={() => setBatchError(null)}
              aria-label="Dismiss error"
              className="shrink-0 w-6 h-6 grid place-items-center rounded-lg"
              style={{ color: styles.textTertiary }}
            >
              <X size={12} />
            </button>
          </div>
        ) : null}

        {/* footer: manual add-by-id — R124: the SAME configure-first
            contract as the row's Add button (the ADD-mode config dialog
            opens on the typed id; Save creates the row). An id that is
            ALREADY configured is handled honestly: the upsert keeps its
            current semantics (Save UPDATES the existing row), and the hint
            below says so before the click. */}
        <div
          className="shrink-0 border-t border-line px-5 py-3.5 flex flex-col gap-1.5"
          data-testid="picker-manual-add"
        >
          <div className="flex items-center gap-2">
            <input
              value={manualId}
              onChange={(e) => setManualId(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && manualId.trim()) addOne(manualId.trim());
              }}
              placeholder="…or enter a model id not in the list"
              aria-label="Model id"
              className="h-10 flex-1 min-w-0 rounded-xl border border-clay-rim bg-well px-3.5 font-mono text-[12px] text-ink outline-none"
            />
            <button
              onClick={() => addOne(manualId.trim())}
              disabled={!manualId.trim() || batchBusy}
              /* R126-3f-2: the QUIET-SOLID clay primary (COMPONENTS §4) —
                 the accentDeep fill + the accentText ink, rounded-lg + the
                 press collapse. */
              className="ac-clay-pressed h-10 px-4 rounded-lg text-[12px] font-semibold bg-accent-deep transition-transform active:scale-[0.98] disabled:opacity-50 shrink-0 cursor-pointer"
              style={{ color: styles.accentText }}
            >
              Add
            </button>
          </div>
          {manualId.trim() !== "" && configuredIds.has(manualId.trim()) && (
            <p className="text-[11px]" style={{ color: styles.textTertiary }} data-testid="picker-manual-already-added">
              Already added — Save updates the existing row.
            </p>
          )}
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
    // R89-C2: the default display NAME is the humanized last segment (the
    // owner: "the last part of the model ID was supposed to be shown as the
    // name") — the prefill's explicit name wins when present.
    displayName: prefill.displayName ?? cleanModelName(prefill.modelId),
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

/** ROUND-87 (R87) → R89-C3 → R91-D: the CAPABILITY CHIP — an on/off pill
 * with the modality's OWN theme color + SVG icon. R91-D (the owner: "the
 * option to add the input capabilities was not highlighted properly. They
 * were not as good as they could be"): the states now read at a glance —
 * ON is a FILLED, saturated pill in the modality's color with a check
 * badge; OFF is a NEUTRAL interactive pill (the old off-state kept a faded
 * tint of the modality color, which read as a DISABLED ghost —
 * indistinguishable from un-clickable). R100-E2: the hover-color promise
 * (the modality's tint arriving as the promise of the click) now rides the
 * CSS leg — the modality color is passed as the --cap custom property and
 * the hover classes mix it in; the useState hover pair is retired
 * (TOKENS.md §6: hover is a class, never a handler). Module level, NOT
 * inside the dialog — a component defined in render remounts its subtree
 * on every keystroke (the classic anti-pattern). */
function CapChip({
  meta,
  on,
  onClick,
  locked = false,
  title,
  testId,
}: {
  meta: CapabilityMeta;
  on: boolean;
  onClick?: () => void;
  locked?: boolean;
  title: string;
  testId: string;
}) {
  const { color, Icon, label } = meta;
  const styles = useThemeStyles();
  return (
    <button
      type="button"
      onClick={locked ? undefined : onClick}
      aria-pressed={on}
      disabled={locked}
      title={title}
      data-testid={testId}
      /* R126-3f-2: the pill's hairline is the 1px token leg (TOKENS §5 —
         the 1.5px bento border retired); the ON/OFF paint stays the owner's
         R87 colored-toggle directive verbatim. */
      className="h-8 px-3 rounded-full text-[11px] font-medium border transition-all shrink-0 disabled:cursor-default flex items-center gap-1.5 cursor-pointer border-line text-muted hover:border-[var(--cap)] hover:bg-[color-mix(in_srgb,var(--cap)_10%,transparent)]"
      style={
        {
          // the modality's color, exposed to the hover classes above.
          "--cap": color,
          ...(on
            ? {
                // ON — the modality's color, fully expressed: saturated fill,
                // solid color border, white icon+label (the inline leg wins
                // over the hover classes, so the settled state never shifts).
                borderColor: color,
                background: color,
                color: "#ffffff",
                opacity: locked ? 0.85 : 1,
              }
            : {
                // OFF — NEUTRAL (the interactive idle): theme border + text so
                // it never reads as a disabled ghost; the resting look rides
                // the border-line/text-muted classes above so the :hover
                // classes can express the color promise.
                color: styles.textSecondary,
                opacity: locked ? 0.85 : 1,
              }),
        } as unknown as CSSProperties
      }
    >
      <Icon size={12} strokeWidth={2.25} aria-hidden style={on ? undefined : { color: withAlpha(color, 0.8) }} />
      {label}
      {on ? <Check size={10} strokeWidth={3} aria-hidden style={{ marginLeft: -2 }} /> : null}
    </button>
  );
}

/** R89-C4 helpers for the sizing/preview formatting: parse once, share
 * everywhere (numOrNull for tokens; priceOrNull for $/1M with 3-decimals
 * trimmed; TokenHint = the compact form rendered under the input). */
function numOrNull(raw: string): number | null {
  const parsed = parseNumericField(raw);
  return parsed === "invalid" ? null : parsed;
}

function priceOrNull(raw: string): string {
  const parsed = parseNumericField(raw);
  if (parsed === "invalid" || parsed === null) return "—";
  return `$${parsed}`;
}

function TokenHint({ raw }: { raw: string }): JSX.Element | null {
  const styles = useThemeStyles();
  const parsed = numOrNull(raw);
  if (parsed === null || parsed < 1000) return null;
  return (
    <span className="block mt-0.5 font-mono text-[10px]" style={{ color: styles.textTertiary }} aria-hidden>
      ≈ {formatTokenCount(parsed)}
    </span>
  );
}

function ModelConfigDialog({
  providerId,
  model,
  prefill,
  catalog,
  onClose,
  onSaved,
}: {
  providerId: string;
  /** EDIT mode: the stored row being configured (null in add mode). */
  model: ProviderModelConfig | null;
  /** ROUND-87 (R87) ADD mode: the catalog prefill (clicking a model in the
   * picker opens this dialog INSTEAD of adding directly — the owner: "It
   * should give the user the option to set them up"). R124: this is now
   * THE single-add flow (configure-first; Save creates the row). */
  prefill: ModelAddPrefill | null;
  /** R124: the provider's live catalog (entries + fetch state) — the smart
   * blank-fill's source. Optional for embeds/tests that prefill fully. */
  catalog?: ProviderCatalogState;
  onClose: () => void;
  onSaved: () => void;
}) {
  const styles = useThemeStyles();
  const addMode = model === null && prefill !== null;
  const [draft, setDraft] = useState<ModelConfigDraft>(() =>
    model !== null ? draftFromModel(model) : draftFromPrefill(prefill ?? { modelId: "" }),
  );
  const [error, setError] = useState<string | null>(null);

  // ── ROUND-124: the SMART BLANK-FILL (the mobile's R120-M configure screen,
  //    now on the desktop — the owner: "if I do the same thing on my mobile,
  //    then it does pre-load the context window, max output, input-output
  //    prices… and everything"). When the dialog opens (add OR edit mode),
  //    the live catalog's additive details fill every field the row/prefill
  //    left BLANK — only-blank policy, a filled value is never overwritten
  //    (the owner's own edits and the static catalog's curated values win).
  //    The status line is honest in every state: fetching → the provider's
  //    answer → "no details served" when the entry carried none. A catalog
  //    fetch FAILURE is silent-but-truthful: the line reads the honest
  //    "no details served" and never blocks the dialog. ──
  const [smartFillState, setSmartFillState] = useState<"idle" | "fetching" | "details" | "none">(
    "idle",
  );
  const modelIdForFill = addMode ? (prefill?.modelId ?? "") : (model?.modelId ?? "");
  useEffect(() => {
    if (modelIdForFill === "" || catalog === undefined) return;
    // The catalog is still loading → the fetching state; the effect re-runs
    // when its entries land.
    if (catalog.isFetching) {
      setSmartFillState("fetching");
      return;
    }
    const entry = catalog.entries.find((e) => e.id === modelIdForFill);
    const live = entry?.details;
    if (live === undefined) {
      setSmartFillState("none");
      return;
    }
    // The only-blank fill: every numeric the draft left "" gets the live
    // value; vision ORs in; the capability chips the draft left NULL get
    // the live hint (audio/video). One pass, guarded against the user
    // having typed anything (the draft's non-empty values win).
    setDraft((d) => {
      const num = (current: string, v?: number): string =>
        current === "" && v !== undefined ? String(v) : current;
      const tri = (current: boolean | null, v?: boolean): boolean | null =>
        current === null && v !== undefined ? v : current;
      return {
        ...d,
        contextWindow: num(d.contextWindow, live.contextWindow),
        maxOutputTokens: num(d.maxOutputTokens, live.maxOutputTokens),
        inputPrice: num(d.inputPrice, live.inputPricePerMtok),
        cachePrice: num(d.cachePrice, live.inputPriceCachedPerMtok),
        outputPrice: num(d.outputPrice, live.outputPricePerMtok),
        supportsVision: d.supportsVision === false && live.supportsVision === true ? true : d.supportsVision,
        supportsAudio: tri(d.supportsAudio, live.supportsAudio),
        supportsVideo: tri(d.supportsVideo, live.supportsVideo),
      };
    });
    setSmartFillState("details");
  }, [modelIdForFill, catalog]);

  // The status line under the dialog's header — the honest record that the
  // pre-load RAN and what it got (the owner: "so that I am aware of whether
  // it even tried to fetch the data for it or not").
  const smartFillLine =
    catalog === undefined
      ? null
      : smartFillState === "fetching"
        ? "fetching the model's live details…"
        : smartFillState === "details"
          ? "live details fetched from the provider — blank fields were filled"
          : smartFillState === "none"
            ? "the provider's catalog served no details for this model"
            : null;

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

  // R126-3f-2: the dialog's inputs ride the well + rim on the CSS-var leg
  // (TOKENS §10) — the shared `inputStyle` JS leg is retired.

  // R89-C4: the preview line's per-field compact formatting (unused parts
  // of the old single-string preview were retired with it).

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
        /* R126-3f-2: THE CONFIG DIALOG = the clay card (the brief's §6 —
           the AddProjectDialog spelling from Phase 2: rounded-xl + the 1px
           clay rim + .ac-clay; TOKENS §5/§9 — the 1.5px border + the
           softShadow leg are retired). */
        className="ac-clay w-full max-w-[680px] max-h-[86vh] overflow-y-auto auto-scroll rounded-xl border p-5 flex flex-col gap-4"
        style={{ background: styles.card, borderColor: styles.clayRim }}
      >
        {/* header — ROUND-87 (R87): ADD vs CONFIGURE + the provider chip
            (the send wire's actual routing target). */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[13px] font-semibold" style={{ color: styles.text }}>
            {addMode ? "Add model" : "Configure model"}
          </span>
          <span
            className="px-1.5 py-0.5 rounded-full font-mono text-[10px] font-medium bg-badge-neutral text-badge-neutral-fg"
            title="The provider that serves this model (the send wire routes here since R82)"
          >
            {providerId}
          </span>
          <span className="flex-1" />
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-7 h-7 grid place-items-center rounded-lg"
            style={{ color: styles.textTertiary }}
          >
            <X size={14} />
          </button>
        </div>

        {/* R124: the smart blank-fill's honest status line — the record that
            the pre-load RAN and what it got (fetching / details / none). */}
        {smartFillLine !== null ? (
          <div
            data-testid="model-smart-fill-line"
            className="flex items-center gap-1.5 text-[11px] leading-tight"
            style={{ color: styles.textTertiary, marginTop: -6 }}
          >
            {smartFillState === "fetching" ? (
              <Loader2 size={11} className="animate-spin shrink-0" aria-hidden />
            ) : (
              <span
                className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
                style={{
                  background:
                    smartFillState === "details" ? styles.accentDeep : styles.textTertiary,
                }}
                aria-hidden
              />
            )}
            {smartFillLine}
          </div>
        ) : null}

        {/* ROUND-82: the two-column body — Identity + Capabilities (left)
            and Sizing + Pricing (right) at ≥560px; single column below
            (small windows / narrow settings panes). */}
        <div className="grid grid-cols-1 min-[560px]:grid-cols-2 gap-4 items-start">
          {/* ── LEFT: Identity + Capabilities ── */}
          <div className="flex flex-col gap-4 min-w-0">
            <div className="flex flex-col gap-2">
              <SectionLabel>Identity</SectionLabel>
              <div>
                <label className="mb-1.5 block text-[11px] font-medium" style={{ color: styles.textSecondary }}>
                  Display name
                </label>
                <input
                  value={draft.displayName}
                  onChange={(e) => set("displayName", e.target.value)}
                  placeholder={draft.modelId || "the friendly name shown in pickers"}
                  aria-label="Display name"
                  className="h-10 w-full rounded-lg border border-clay-rim bg-well px-3 text-[13px] text-ink outline-none"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-[11px] font-medium" style={{ color: styles.textSecondary }}>
                  Model id
                </label>
                {addMode ? (
                  <input
                    value={draft.modelId}
                    onChange={(e) => set("modelId", e.target.value)}
                    placeholder="provider/model-name"
                    aria-label="Model id"
                    className="h-10 w-full rounded-lg border border-clay-rim bg-well px-3 font-mono text-[11px] text-ink outline-none"
                    data-testid="model-config-id-input"
                  />
                ) : (
                  <p
                    className="h-10 flex items-center w-full rounded-lg border border-clay-rim bg-well px-3 font-mono text-[11px] break-all overflow-hidden"
                    style={{ color: styles.textTertiary }}
                    aria-label="Model id (read-only)"
                  >
                    {draft.modelId}
                  </p>
                )}
              </div>
              {/* ROUND-87 (R87): the SIZE label — a human-facing parameter
                  size ("70B", "405B MoE") for the detail row. */}
              <div>
                <label className="mb-1.5 block text-[11px] font-medium" style={{ color: styles.textSecondary }}>
                  Size <span className="font-normal" style={{ color: styles.textTertiary }}>(e.g. 70B — display only)</span>
                </label>
                <input
                  value={draft.sizeLabel}
                  onChange={(e) => set("sizeLabel", e.target.value)}
                  placeholder="unknown"
                  aria-label="Size label"
                  className="h-10 w-full rounded-lg border border-clay-rim bg-well px-3 text-[13px] text-ink outline-none"
                  data-testid="model-config-size-input"
                />
              </div>
              {/* R100-E2: the label+control pair rides the SettingsRow
                  primitive (36px control row, 13px/400 label + 11px
                  tertiary description — TOKENS.md §3 row-height table). */}
              <SettingsRow label="Hide from chat picker" description="Stays in Settings — hidden from chat.">
                <div
                  role="group"
                  aria-label="Hide from chat picker"
                  /* R126-3f-2: the segmented control = the 1px clay rim + the
                     accentTint/accentDeep ACTIVE segment (the ModelSelector
                     spelling); the 1.5px border + the withAlpha fill are
                     retired. */
                  className="flex items-center rounded-lg border border-clay-rim overflow-hidden shrink-0"
                >
                  {([
                    { id: "on", label: "On", active: draft.hidden, pick: () => set("hidden", true) },
                    { id: "off", label: "Off", active: !draft.hidden, pick: () => set("hidden", false) },
                  ] as const).map((seg) => (
                    <button
                      key={seg.id}
                      onClick={seg.pick}
                      aria-pressed={seg.active}
                      className={`h-7 px-3 text-[11px] font-medium transition-colors duration-100 cursor-pointer ${
                        seg.active ? "bg-accent-tint text-accent-deep" : "text-muted hover:text-ink"
                      }`}
                    >
                      {seg.label}
                    </button>
                  ))}
                </div>
              </SettingsRow>
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
                <CapChip meta={CAPABILITY_META[0]} on locked title="Every chat model accepts text input" testId="model-cap-text-in" />
                <CapChip
                  meta={CAPABILITY_META[1]}
                  on={draft.supportsVision}
                  onClick={() => set("supportsVision", !draft.supportsVision)}
                  title="Accepts image inputs — gates the main-mode vision relay"
                  testId="model-cap-images-in"
                />
                <CapChip
                  meta={CAPABILITY_META[2]}
                  on={draft.supportsVideo === true}
                  onClick={() => set("supportsVideo", draft.supportsVideo === true ? false : true)}
                  title="Accepts video inputs"
                  testId="model-cap-video-in"
                />
                <CapChip
                  meta={CAPABILITY_META[3]}
                  on={draft.supportsPdf === true}
                  onClick={() => set("supportsPdf", draft.supportsPdf === true ? false : true)}
                  title="Accepts PDF documents"
                  testId="model-cap-pdf-in"
                />
                <CapChip
                  meta={CAPABILITY_META[4]}
                  on={draft.supportsAudio === true}
                  onClick={() => set("supportsAudio", draft.supportsAudio === true ? false : true)}
                  title="Accepts audio inputs"
                  testId="model-cap-audio-in"
                />
              </div>
              <SectionLabel>Output capabilities</SectionLabel>
              <div className="flex flex-wrap gap-1.5">
                <CapChip
                  meta={CAPABILITY_META[0]}
                  on={draft.supportsTextOutput !== false}
                  onClick={() => set("supportsTextOutput", draft.supportsTextOutput !== false ? false : true)}
                  title="Produces text output — on by default for chat models"
                  testId="model-cap-text-out"
                />
                <CapChip
                  meta={CAPABILITY_META[1]}
                  on={draft.supportsImageOutput === true}
                  onClick={() => set("supportsImageOutput", draft.supportsImageOutput === true ? false : true)}
                  title="Produces image output"
                  testId="model-cap-images-out"
                />
                <CapChip
                  meta={CAPABILITY_META[2]}
                  on={draft.supportsVideoOutput === true}
                  onClick={() => set("supportsVideoOutput", draft.supportsVideoOutput === true ? false : true)}
                  title="Produces video output"
                  testId="model-cap-video-out"
                />
                <CapChip
                  meta={CAPABILITY_META[4]}
                  on={draft.supportsAudioOutput === true}
                  onClick={() => set("supportsAudioOutput", draft.supportsAudioOutput === true ? false : true)}
                  title="Produces audio output"
                  testId="model-cap-audio-out"
                />
              </div>
              <p className="text-[10px]" style={{ color: styles.textTertiary }}>
                Reasoning and tool use are detected automatically — never configured here.
              </p>
            </div>
          </div>

          {/* ── RIGHT: Sizing + Pricing ── */}
          <div className="flex flex-col gap-4 min-w-0">
            {/* sizing — R89-C4 (the owner: "if I enter 1 million context
                then it should show the formatted version there, like 1M"):
                every numeric field carries a live compact-form hint under
                the input (1000000 → ≈ 1M; unset renders nothing). */}
            <div className="flex flex-col gap-2">
              <SectionLabel>Sizing</SectionLabel>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="mb-1 block text-[11px] font-medium" style={{ color: styles.textTertiary }}>
                    Context window (tokens)
                  </label>
                  <input
                    value={draft.contextWindow}
                    onChange={(e) => set("contextWindow", e.target.value)}
                    placeholder="unknown"
                    aria-label="Context window (tokens)"
                    className="h-10 w-full rounded-lg border border-clay-rim bg-well px-3 font-mono text-[12px] text-ink outline-none tabular-nums"
                  />
                  <TokenHint raw={draft.contextWindow} />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-medium" style={{ color: styles.textTertiary }}>
                    Max output tokens
                  </label>
                  <input
                    value={draft.maxOutputTokens}
                    onChange={(e) => set("maxOutputTokens", e.target.value)}
                    placeholder="unknown"
                    aria-label="Max output tokens"
                    className="h-10 w-full rounded-lg border border-clay-rim bg-well px-3 font-mono text-[12px] text-ink outline-none tabular-nums"
                  />
                  <TokenHint raw={draft.maxOutputTokens} />
                </div>
              </div>
            </div>

            {/* pricing */}
            <div className="flex flex-col gap-2">
              <SectionLabel>Pricing — USD per 1M tokens</SectionLabel>
              <div className="grid grid-cols-1 gap-2">
                <div>
                  <label className="mb-1 block text-[11px] font-medium" style={{ color: styles.textTertiary }}>
                    Input price
                  </label>
                  <input
                    value={draft.inputPrice}
                    onChange={(e) => set("inputPrice", e.target.value)}
                    inputMode="decimal"
                    placeholder="unknown"
                    aria-label="Input price ($ per 1M tokens)"
                    className="h-10 w-full rounded-lg border border-clay-rim bg-well px-3 font-mono text-[12px] text-ink outline-none tabular-nums"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-medium" style={{ color: styles.textTertiary }}>
                    Output price
                  </label>
                  <input
                    value={draft.outputPrice}
                    onChange={(e) => set("outputPrice", e.target.value)}
                    inputMode="decimal"
                    placeholder="unknown"
                    aria-label="Output price ($ per 1M tokens)"
                    className="h-10 w-full rounded-lg border border-clay-rim bg-well px-3 font-mono text-[12px] text-ink outline-none tabular-nums"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-medium" style={{ color: styles.textTertiary }}>
                    Cache read price
                  </label>
                  <input
                    value={draft.cachePrice}
                    onChange={(e) => set("cachePrice", e.target.value)}
                    inputMode="decimal"
                    placeholder="unknown"
                    aria-label="Cache read price ($ per 1M tokens)"
                    className="h-10 w-full rounded-lg border border-clay-rim bg-well px-3 font-mono text-[12px] text-ink outline-none tabular-nums"
                  />
                </div>
              </div>
              <p className="text-[11px]" style={{ color: styles.textTertiary }}>
                Each field is US dollars per 1 million tokens — leave empty for unknown (an empty price is never treated as $0).
              </p>
            </div>

            {/* live preview — R89-C4: the formatted summary (context +
                max output in compact form + the pricing trio, unset → —).
                R126-3f-2: the preview rides THE WELL + the clay rim
                (TOKENS §10) with mono tabular-nums — the subtle fill is
                retired. */}
            <div
              className="rounded-lg border border-clay-rim bg-well px-3 py-2 font-mono text-[11px] tabular-nums flex flex-wrap gap-x-3 gap-y-0.5"
              style={{ color: styles.textTertiary }}
              data-testid="model-config-preview"
            >
              <span>{`ctx ${formatTokenCount(numOrNull(draft.contextWindow))}`}</span>
              <span>{`max out ${formatTokenCount(numOrNull(draft.maxOutputTokens))}`}</span>
              <span>{`in ${priceOrNull(draft.inputPrice)}`}</span>
              <span>{`out ${priceOrNull(draft.outputPrice)}`}</span>
              <span>{`cache ${priceOrNull(draft.cachePrice)}`}</span>
            </div>
          </div>
        </div>

        {error && (
          <p role="alert" className="text-[11px] text-danger-deep">
            {error}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={onClose}
            /* R126-3f-2: the SECONDARY species (COMPONENTS §4) — the 1px
               border-strong outline + secondary ink + the hover bg-subtle
               wash + the press floor. */
            className="h-10 px-4 rounded-lg border border-line-strong text-[12px] font-semibold transition-colors duration-100 hover:bg-subtle active:scale-[0.98] cursor-pointer"
            style={{ color: styles.textSecondary }}
          >
            Cancel
          </button>
          {model !== null && <ModelTestButton model={model} />}
          <span className="flex-1" />
          <button
            onClick={submit}
            disabled={save.isPending}
            /* R126-3f-2: the QUIET-SOLID clay primary (COMPONENTS §4 — the
               AddProjectDialog spelling, the brief's §6 CTA): the accentDeep
               fill on the class leg + the accentText ink on the JS leg
               (text-accent-text is a phantom utility), rounded-lg + the
               ac-clay-pressed press collapse; the accent fill + the pill
               radius are retired. */
            className="ac-clay-pressed h-10 px-5 rounded-lg text-[13px] font-semibold bg-accent-deep transition-transform active:scale-[0.98] disabled:opacity-50 cursor-pointer"
            style={{ color: styles.accentText }}
            data-testid="model-config-save"
          >
            {save.isPending ? "Saving…" : addMode ? "Add model" : "Save configuration"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── R92-D3: the unified per-provider API keys card ──────────────────────────
 * The owner's multi-key rework: "In Models and Providers, the user can add
 * more than one API key for a specific provider. Those API keys will be
 * juggled between each other. If one API key fails, it will automatically
 * try the next API key in line and so forth."
 *
 * ONE card, ONE list:
 *  - Key 1 — the PRIMARY key editor (R60-B semantics, moved here verbatim
 *    from the Connection card: paste-to-replace, ONE eye slot, Copy while
 *    revealed; slot 0 on the wire).
 *  - Key 2..N — the pool rows (masked by default, per-row reveal + copy +
 *    remove; the R58-d security semantics hold — full values are NEVER
 *    auto-fetched and never render by default).
 *  - The always-on add row — appends to the FIRST FREE slot ≥ 1 through the
 *    slot-aware path in BOTH modes:
 *      · Tauri  → store_provider_key_slot (the R92-D1 shell command) — the
 *        R47 FIX: the pre-R92 bug invoked the slot-less store_provider_key
 *        here, which OVERWROTE the primary key.
 *      · web    → PUT /providers/:id/keys/:slot.
 *  - Labels are ORDINALS, not slot numbers: Key 1 (slot 0), then the 1-based
 *    index in the sorted list of held slots. A pool holding slots 2 and 5
 *    renders Key 2 / Key 3 — the ordinal is positional, the slot internal.
 * Sub-agents share this pool (their own key card is gone — see SubAgentsTab);
 * the orchestrator juggles keys on rate limits / auth failures. */

/** R92-D3: the DISPLAY ordinal of a held key — its 1-based position in the
 * sorted list of held slots (Key 1 = the primary at slot 0, then ascending).
 * The raw slot number stays an internal detail: gaps never surface. */
function keyOrdinal(slot: number, primaryHeld: boolean, heldPoolSlotsAsc: readonly number[]): number {
  const held = [...(primaryHeld ? [0] : []), ...heldPoolSlotsAsc].sort((a, b) => a - b);
  const index = held.indexOf(slot);
  return index < 0 ? held.length + 1 : index + 1;
}

/** Exported for the regression tests — the slot-aware add-key path and the
 * Key-N ordinals live here. */
export function ProviderKeysCard({ provider }: { provider: ProviderView }) {
  const styles = useThemeStyles();
  const queryClient = useQueryClient();
  const resetAfter = useTimeoutClear();

  // ── Key 1 (the primary) — the R60-B editor state, moved verbatim ────────
  // ROUND-60 (R60-B): the paste-to-replace draft — null means "not editing"
  // (the field displays the STORED key, masked or revealed read-only);
  // any non-null string is the user's typed/pasted NEW key awaiting Save.
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
  const [keyStatus, setKeyStatus] = useState<string | null>(null);
  // ROUND-59 (R59-C): copy confirmations/errors color themselves (a copy
  // failure must not inherit the save-mutation's green styling).
  const [keyStatusIsError, setKeyStatusIsError] = useState(false);
  // R102-A: the key-file disclosure leg — a save that landed in
  // ~/.acute/provider-keys.json (the ADR-0031-addendum Linux fallback)
  // colors AMBER, not green: the note tells the owner WHERE the key went
  // and how to move it into the encrypted store. Distinct from an error:
  // the save SUCCEEDED.
  const [keyStatusIsWarning, setKeyStatusIsWarning] = useState(false);

  // ── Key 2..N (the pool) + the add row ────────────────────────────────────
  const [newKey, setNewKey] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [poolMsg, setPoolMsg] = useState<string | null>(null);
  // R102-A: the pool add-row's amber leg — same disclosure semantics as
  // the primary editor's keyStatusIsWarning (a key-file save is a SUCCESS
  // in a different store, not an error).
  const [poolMsgIsWarning, setPoolMsgIsWarning] = useState(false);
  // ROUND-58 (R58-d): per-row revealed pool values — masked by default; the
  // reveal fetch is ONE call per provider (the route returns every slot) and
  // its result is CACHED here, while the SHOWING state is a per-row toggle.
  // Never auto-fetched on mount.
  const [revealedValues, setRevealedValues] = useState<Record<number, string>>({});
  const [revealedRows, setRevealedRows] = useState<Set<number>>(new Set());
  // R95-A: WHICH row's reveal fetch is in flight (null = none) — the rows
  // are Key-1-lookalikes now, so only the CLICKED row spins (the old global
  // boolean spun every eye at once).
  const [revealLoadingSlot, setRevealLoadingSlot] = useState<number | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);
  /** R95-A: the pool row whose removal is awaiting the styled
   * ConfirmDialog (the browser window.confirm is retired). */
  const [pendingRemoveSlot, setPendingRemoveSlot] = useState<KeyPoolSlot | null>(null);

  // Same query key the detail pane's test-key selector uses — one cache.
  const poolQuery = useQuery({
    queryKey: ["key-pool", provider.id],
    queryFn: () => fetchKeyPool(provider.id),
  });
  const pool = poolQuery.data ?? [];
  // R92-D3: the pool rows — HELD slots > 0, ascending (the ordinals are
  // positional). Keyless rows never render; Key 1 above is the primary.
  const heldSlots = pool
    .filter((k) => k.slot > 0 && k.hasKey)
    .sort((a, b) => a.slot - b.slot);
  const heldSlotNumbers = heldSlots.map((k) => k.slot);
  const primaryHeld = provider.hasKey;
  const keyCount = heldSlots.length + (primaryHeld ? 1 : 0);
  // ROUND-59 (R59-C): the masked slot-0 (primary) value — from the same
  // shared key-pool listing; dots while it loads or if it omits slot 0.
  const maskedStoredKey = pool.find((k) => k.slot === 0 && k.hasKey)?.masked ?? "•••••••••••";

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["key-pool", provider.id] });
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

  // ── Key 1 saves through the PRIMARY path (slot 0) in both modes ──────────
  const saveKey = useMutation({
    mutationFn: async (value: string) => {
      // Tauri: keys route through the shell into the OS secure store
      // (ADR-0012). Browser dev: the sidecar keyring endpoint.
      // R102-A: the shell path now RETURNS a KeyStoreReport (where the key
      // landed + the key-file disclosure note) — surfaced in onSuccess.
      if (isTauri()) {
        const { storeProviderKey: storeViaShell } = await import("../onboarding/providers-api");
        const report = await storeViaShell(provider.id, value);
        if (!report) throw new Error("the shell refused the key store request");
        return report;
      }
      await storeProviderKey(provider.id, value);
      return null;
    },
    onSuccess: (report) => {
      // ROUND-60 (R60-B): a saved key exits edit mode (the masked
      // stored-key view returns — a stale revealed OLD value is dropped
      // too) and refreshes the pool listing so the masked slot-0 value is
      // the NEW key's, never the stale one.
      setKeyDraft(null);
      setRevealState({ kind: "idle" });
      // R102-A: the disclosure — a key-file save (the Linux fallback when
      // no Secret Service is reachable) renders its note AMBER so the
      // owner knows the key is in ~/.acute/provider-keys.json (0600), not
      // the encrypted store; every secure-store save stays the green
      // one-liner.
      if (report?.store === "key-file") {
        setKeyStatusIsError(false);
        setKeyStatusIsWarning(true);
        setKeyStatus(
          report.note ??
            "Key saved to the local key file — no Secret Service keyring was reachable.",
        );
      } else {
        setKeyStatusIsError(false);
        setKeyStatusIsWarning(false);
        setKeyStatus("Key saved to the secure store.");
      }
      // ROUND-62 (R62-2b): hasKey flips — the picker's provider cache sees
      // it (the session page doesn't list keyless presets differently, but
      // one cache, one truth).
      invalidateProvidersEverywhere(queryClient);
      void queryClient.invalidateQueries({ queryKey: ["key-pool", provider.id] });
    },
    onError: (err: Error) => {
      setKeyStatusIsError(true);
      setKeyStatusIsWarning(false);
      setKeyStatus(err.message);
    },
  });

  // ── The add row — THE R92-D3 / R47 FIX ────────────────────────────────────
  // The first FREE slot ≥ 1 (a gap is filled, never a held slot overwritten —
  // the R47-c1 collision fix, now floor 1) through the SLOT-AWARE path in
  // BOTH modes. The pre-R92 Tauri bug: this invoked the slot-less
  // store_provider_key, which stored the PRIMARY — adding "another key"
  // silently replaced Key 1.
  const addKey = useMutation({
    mutationFn: async (value: string) => {
      // The LIVE listing at click time (the render closure could be one
      // refetch behind a pool another surface just changed).
      const poolNow =
        queryClient.getQueryData<KeyPoolSlot[]>(["key-pool", provider.id]) ?? pool;
      const slot = nextFreeSlot(poolNow.filter((k) => k.hasKey).map((k) => k.slot));
      if (slot < 0) throw new Error("the key pool is full (31 keys)");
      if (isTauri()) {
        const { storeProviderKeySlot: storeViaShell } = await import("../onboarding/providers-api");
        const report = await storeViaShell(provider.id, slot, value);
        if (!report) throw new Error("the shell refused the key store request");
        return report;
      }
      await setKeyPoolSlot(provider.id, slot, value);
      return null;
    },
    onSuccess: (report) => {
      setNewKey("");
      // R102-A: same disclosure as the primary editor — a key-file save
      // renders its note amber (the save SUCCEEDED; the store differs).
      if (report?.store === "key-file") {
        setPoolMsgIsWarning(true);
        setPoolMsg(
          report.note ??
            "Key saved to the local key file — no Secret Service keyring was reachable.",
        );
        resetAfter(() => setPoolMsg(null), 8000);
      } else {
        setPoolMsgIsWarning(false);
        setPoolMsg("Key added.");
        resetAfter(() => setPoolMsg(null), 1500);
      }
      resetRevealCache();
      invalidate();
    },
    onError: (err: Error) => {
      setPoolMsgIsWarning(false);
      setPoolMsg(err.message);
    },
  });

  // ── Pool-row removal — slot-aware in both modes ───────────────────────────
  // Tauri: the shell command retires the DURABLE credential (canonical +
  // legacy targets + the note line); the REST DELETE that follows clears the
  // RUNNING sidecar's in-memory keyring so the listing refetch shows the
  // truth without a restart (the shell command has no handoff — R92-D1).
  // Browser dev: the REST DELETE alone.
  const removeKey = useMutation({
    mutationFn: async (slot: number) => {
      if (isTauri()) {
        const { removeProviderKeySlot: removeViaShell } = await import("../onboarding/providers-api");
        const ok = await removeViaShell(provider.id, slot);
        if (!ok) throw new Error("the shell refused the key removal request");
      }
      await removeKeyPoolSlot(provider.id, slot);
    },
    onSuccess: () => {
      resetRevealCache();
      invalidate();
    },
    onError: (err: Error) => setPoolMsg(err.message),
  });

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

  // ROUND-58 (R58-d): reveal one pool row's FULL value. The reveal route
  // returns every held slot in ONE response — the FIRST reveal fetches it and
  // caches the map (zero extra calls afterwards); each row's showing state is
  // its own toggle. Never called on mount.
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
    const listingSaysHeld = pool.find((k) => k.slot === slot)?.hasKey === true;
    if (Object.keys(map).length === 0 || (map[slot] === undefined && listingSaysHeld)) {
      // First reveal this mount (or a cache-miss) — one fetch fills it.
      // R95-A: only the CLICKED row's eye spins (revealLoadingSlot).
      setRevealError(null);
      setRevealLoadingSlot(slot);
      try {
        const keys = await revealProviderKeys(provider.id);
        map = {};
        for (const k of keys) map[k.slot] = k.value;
        setRevealedValues(map);
      } catch (err) {
        setRevealError(err instanceof Error ? err.message : String(err));
        return;
      } finally {
        setRevealLoadingSlot(null);
      }
    }
    if (map[slot] === undefined) {
      // Fetched/cached, but this slot holds no key — honest.
      setRevealError(`Key ${keyOrdinal(slot, primaryHeld, heldSlotNumbers)} has no stored key.`);
      return;
    }
    setRevealedRows((prev) => new Set(prev).add(slot));
  };

  const copySlotValue = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setPoolMsg("Key copied to clipboard.");
      resetAfter(() => setPoolMsg(null), 1500);
    } catch {
      setPoolMsg("Copy failed — the clipboard is unavailable in this context.");
      resetAfter(() => setPoolMsg(null), 1500);
    }
  };

  // ROUND-60 (R60-B): the two display values the unified key field rides —
  // storedDisplay is what the input shows while NOT editing (the masked
  // slot-0 value, or the revealed full key); revealedValue is non-null only
  // while revealed (captured per render, so the fading-out Copy button can
  // never copy a stale value).
  const storedDisplay = revealState.kind === "shown" ? revealState.value : maskedStoredKey;
  const revealedValue = revealState.kind === "shown" ? revealState.value : null;

  return (
    /* R100-E2: the SectionCard primitive — the aria-label passthrough keeps
       the card's accessible name (its tests pin the "API keys" label).
       R126-3f-2: the primitive now carries the CLAY card (3f-1) — free. */
    <SectionCard
      className="p-4 md:p-5 flex flex-col gap-3"
      ariaLabel="API keys"
    >
      <div>
        <SectionLabel>{`API keys — ${keyCount}`}</SectionLabel>
        {/* R92-D3: the juggling contract, stated plainly. */}
        <p className="mt-1 text-[11px]" style={{ color: styles.textTertiary }}>
          If a key hits a rate limit or is rejected, the next key is tried automatically —
          sub-agents use the same pool.
        </p>
      </div>
      {/* R126-3f-2: the keys list = the flat rows + hairline dividers inside
          the pane (the brief's §1) — the 1.5px container border is the clay
          rim now. */}
      <div className="rounded-lg border border-clay-rim overflow-hidden">
        {/* ── Key 1 — the primary (R60-B editor, verbatim semantics) ─────── */}
        <div
          data-pool-slot={0}
          data-key-ordinal={1}
          className="flex items-center gap-2.5 px-3 py-2.5 border-b border-line"
        >
          {/* R95-A: the label groups of Key 1 AND every pool row share a fixed
              min-width so the value fields + action buttons all start at the
              same x — the rows read as ONE aligned list (the owner's key-row
              parity ask). */}
          <span className="flex items-center gap-1.5 shrink-0 min-w-[108px]">
            <span className="text-[11px] font-mono font-medium" style={{ color: styles.textSecondary }}>
              KEY 1
            </span>
            {/* R126-3f-2: the state chip = the §11 ACCENT badge tone. */}
            <span
              className="text-[10px] font-medium uppercase tracking-wider rounded-full px-1.5 py-0.5 bg-badge-accent text-badge-accent-fg"
              title="The provider's first key — stored at slot 0 and tried first"
            >
              primary
            </span>
          </span>
          <div className="flex gap-2 items-stretch flex-1 min-w-0">
            <input
              // Cleartext on purpose — the ONE eye in this row belongs to
              // the STORED key; masking the user's own draft is what bred
              // the R58 two-eye ambiguity.
              type="text"
              value={primaryHeld && keyDraft === null ? storedDisplay : keyDraft ?? ""}
              placeholder={primaryHeld ? undefined : "sk-…"}
              aria-label={
                primaryHeld && keyDraft === null
                  ? revealState.kind === "shown"
                    ? "Stored API key (revealed)"
                    : "Stored API key (masked)"
                  : "API key"
              }
              data-testid={
                primaryHeld && keyDraft === null
                  ? revealState.kind === "shown"
                    ? "stored-key-revealed"
                    : "stored-key-masked"
                  : "new-key-input"
              }
              title={
                primaryHeld
                  ? keyDraft === null
                    ? "The stored key — paste a new key to replace it"
                    : "The new key — Save key replaces the stored one"
                  : "Paste the provider's API key"
              }
              // Whole-value select on focus while at rest: click + paste
              // replaces the stored key in ONE gesture (paste-to-replace).
              onFocus={(e) => {
                if (primaryHeld && keyDraft === null) e.currentTarget.select();
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
              /* R126-3f-2: the masked keys = MONO ON THE WELL (the brief's §4
                 — bg-well + the 1px clay rim + the accent EDGE class when a
                 draft is live or the value is revealed; the withAlpha
                 accent borders are retired). */
              className={`h-10 flex-1 min-w-0 rounded-lg border border-clay-rim bg-well px-3 font-mono text-[12px] text-ink outline-none ${
                keyDraft !== null || revealState.kind === "shown" ? "border-accent" : ""
              }`}
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
              disabled={!primaryHeld || keyDraft !== null || revealState.kind === "loading"}
              aria-label={revealState.kind === "shown" ? "Hide stored key" : "Show stored key"}
              data-testid={revealState.kind === "shown" ? "hide-stored-key-button" : "show-stored-key-button"}
              title={
                !primaryHeld
                  ? "No stored key to reveal yet"
                  : revealState.kind === "shown"
                    ? "Mask the stored key again"
                    : "Show the stored key"
              }
              className="h-10 w-10 grid place-items-center rounded-lg border border-clay-rim bg-well shrink-0 disabled:opacity-40"
              style={{
                color: revealState.kind === "shown" ? styles.accentDeep : styles.textTertiary,
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
            {keyDraft !== null || !primaryHeld ? (
              <>
                <button
                  type="button"
                  onClick={() => {
                    if (keyDraft !== null && keyDraft.trim() !== "") saveKey.mutate(keyDraft.trim());
                  }}
                  disabled={keyDraft === null || keyDraft.trim() === "" || saveKey.isPending}
                  aria-label="Save key"
                  data-testid="save-key-button"
                  /* R126-3f-2: the QUIET-SOLID clay primary (COMPONENTS §4) —
                     the accentDeep fill on the class leg + the accentText
                     ink on the JS leg, rounded-lg + the press collapse. */
                  className="ac-clay-pressed h-10 px-4 rounded-lg text-[12px] font-semibold bg-accent-deep transition-transform active:scale-[0.98] disabled:opacity-50 shrink-0 cursor-pointer"
                  style={{ color: styles.accentText }}
                >
                  {saveKey.isPending ? "Saving…" : "Save key"}
                </button>
                {primaryHeld && (
                  <button
                    type="button"
                    onClick={() => setKeyDraft(null)}
                    aria-label="Cancel key edit"
                    data-testid="cancel-key-edit-button"
                    title="Restore the stored key display"
                    className="h-10 w-10 grid place-items-center rounded-lg border border-clay-rim shrink-0 transition-colors duration-100 hover:bg-hover cursor-pointer"
                    style={{ color: styles.textTertiary }}
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
                      className="h-10 px-3.5 rounded-lg border border-clay-rim text-[12px] font-semibold flex items-center gap-1.5 shrink-0 whitespace-nowrap"
                      style={{ color: styles.textSecondary }}
                    >
                      <Copy size={12} /> Copy
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>
            )}
          </div>
        </div>
        {/* ── Key 2..N — the pool rows. ROUND-95 (R95-A, the owner: "The first
            primary API key… looks good and proper but the second one which
            gets added is a bit different in terms of its UI… For the other
            ones, the primary key UI and the other keys' UI should be exactly
            the same"): every pool row now mirrors Key 1's visual language
            EXACTLY — the read-only display field (bordered h-10,
            input-styled), the SAME bordered h-10 w-10 eye with its
            spinner-while-loading, the SAME animated fade/slide-in Copy
            (shown ONLY while revealed), and a matching bordered trash whose
            hover turns red. The only differences are the contract ones: no
            "primary" badge (Key 1 only), and the value is read-only (pool
            keys are removed/re-added, never edited in place). The removal
            confirm is the shared styled ConfirmDialog (R95-A). */}
        {heldSlots.map((k) => {
          const ordinal = keyOrdinal(k.slot, primaryHeld, heldSlotNumbers);
          const revealed = revealedRows.has(k.slot) ? revealedValues[k.slot] : undefined;
          const rowLoading = revealLoadingSlot === k.slot;
          return (
            <div
              key={k.slot}
              data-pool-slot={k.slot}
              data-key-ordinal={ordinal}
              className="flex items-center gap-2.5 px-3 py-2.5 border-b border-line last:border-b-0"
            >
              <span className="flex items-center gap-1.5 shrink-0 min-w-[108px]">
                <span className="text-[11px] font-mono font-medium" style={{ color: styles.textSecondary }}>
                  KEY {ordinal}
                </span>
              </span>
              <div className="flex gap-2 items-stretch flex-1 min-w-0">
                {/* The value display — the SAME field look as Key 1 (masked
                    dots at rest, the full key while revealed, the accent
                    border exactly like Key 1's revealed state). */}
                <div
                  aria-label={`Key ${ordinal} value`}
                  data-revealed-value={revealed !== undefined ? "true" : undefined}
                  title={
                    revealed !== undefined
                      ? "The stored key — revealed"
                      : "The stored key (masked) — use the eye to reveal"
                  }
                  /* R126-3f-2: the masked value = MONO ON THE WELL with the
                     accent EDGE while revealed (the brief's §4). */
                  className={`min-h-10 flex-1 min-w-0 rounded-lg border border-clay-rim bg-well px-3 flex items-center font-mono text-[12px] overflow-hidden ${
                    revealed !== undefined ? "border-accent" : ""
                  }`}
                  style={{
                    color: revealed !== undefined ? styles.text : styles.textSecondary,
                  }}
                >
                  {revealed !== undefined ? (
                    <span className="w-full break-all text-[11px] leading-snug py-1.5">
                      {revealed}
                    </span>
                  ) : (
                    <span className="w-full truncate">{k.masked ?? "—"}</span>
                  )}
                </div>
                {/* THE eye toggle — the same bordered button as Key 1's: only
                    the CLICKED row spins; every eye disables while any reveal
                    fetch is in flight (no double-click can fire two). */}
                <button
                  type="button"
                  onClick={() => void revealSlot(k.slot)}
                  disabled={revealLoadingSlot !== null}
                  aria-label={revealed !== undefined ? `Hide key ${ordinal}` : `Reveal key ${ordinal}`}
                  title={revealed !== undefined ? "Mask again" : "Show the full key"}
                  className="h-10 w-10 grid place-items-center rounded-lg border border-clay-rim bg-well shrink-0 disabled:opacity-40"
                  style={{
                    color: revealed !== undefined ? styles.accentDeep : styles.textTertiary,
                  }}
                >
                  {rowLoading ? (
                    <RefreshCw size={13} className="animate-spin" />
                  ) : revealed !== undefined ? (
                    <EyeOff size={13} />
                  ) : (
                    <Eye size={13} />
                  )}
                </button>
                {/* The Copy — the SAME animated fade/slide-in as Key 1's,
                    mounted ONLY while revealed (the value is captured per
                    render, so a fading-out Copy can never copy a stale key). */}
                <AnimatePresence initial={false}>
                  {revealed !== undefined && (
                    <motion.div
                      key={`copy-pool-key-${k.slot}`}
                      initial={{ opacity: 0, width: 0 }}
                      animate={{ opacity: 1, width: "auto" }}
                      exit={{ opacity: 0, width: 0 }}
                      transition={{ duration: 0.2, ease: "easeOut" }}
                      className="overflow-hidden shrink-0"
                    >
                      <button
                        type="button"
                        onClick={() => void copySlotValue(revealed)}
                        aria-label={`Copy key ${ordinal}`}
                        data-testid="copy-pool-key-button"
                        title="Copy the full key"
                        className="h-10 px-3.5 rounded-lg border border-clay-rim text-[12px] font-semibold flex items-center gap-1.5 shrink-0 whitespace-nowrap"
                        style={{ color: styles.textSecondary }}
                      >
                        <Copy size={12} /> Copy
                      </button>
                    </motion.div>
                  )}
                </AnimatePresence>
                {/* The trash — the same bordered button family. R100-E2: the
                    JS hover-red pair retired. R126-3f-2: the OUTLINED DANGER
                    species (the brief's §4 — 1px border-danger-deep +
                    text-danger-deep on the class leg + the 3a/3b press
                    floor). Opens the styled ConfirmDialog (R95-A), never
                    window.confirm. */}
                <button
                  type="button"
                  onClick={() => setPendingRemoveSlot(k)}
                  aria-label={`Remove key ${ordinal}`}
                  title="Remove key"
                  className="h-10 w-10 grid place-items-center rounded-lg border border-danger-deep text-danger-deep shrink-0 transition-colors duration-100 hover:bg-hover active:scale-[0.98] cursor-pointer"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          );
        })}
        {/* R95-A: the pool-key removal confirm — the styled popup that
            replaces the browser's window.confirm. */}
        {pendingRemoveSlot !== null && (
          <ConfirmDialog
            title={`Remove key ${keyOrdinal(pendingRemoveSlot.slot, primaryHeld, heldSlotNumbers)}?`}
            message="This key will no longer be used for automatic failover."
            confirmLabel="Remove key"
            danger
            onConfirm={() => {
              removeKey.mutate(pendingRemoveSlot.slot);
              setPendingRemoveSlot(null);
            }}
            onClose={() => setPendingRemoveSlot(null)}
          />
        )}
        {/* ── The add row — always appends to the first free slot ≥ 1 ──────
            (R92-D3; the R47 Tauri overwrite fix rides the mutation above).
            A full pool replaces it with the honest note. */}
        {nextFreeSlot(pool.filter((k) => k.hasKey).map((k) => k.slot)) < 0 ? (
          <div
            className="px-3 py-2.5 text-[11px] border-t border-line"
            style={{ color: styles.textTertiary }}
            data-testid="pool-full-note"
          >
            The key pool is full (31 keys) — remove one to add another.
          </div>
        ) : (
          <div className="flex items-center gap-2 px-3 py-2 border-t border-line">
            <span className="text-[11px] font-mono font-medium shrink-0" style={{ color: styles.textTertiary }}>
              KEY {keyCount + 1}
            </span>
            <div className="relative flex-1 min-w-0">
              <input
                type={showNew ? "text" : "password"}
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                placeholder="another key for this provider (sk-…)"
                aria-label="New API key"
                data-testid="add-key-input"
                className="h-8 w-full rounded-lg border border-clay-rim bg-well px-2.5 pr-8 font-mono text-[11px] text-ink outline-none"
              />
              <button
                onClick={() => setShowNew((v) => !v)}
                aria-label={showNew ? "Hide key" : "Show key"}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 w-5 h-5 grid place-items-center rounded-lg"
                style={{ color: styles.textTertiary }}
              >
                {showNew ? <EyeOff size={11} /> : <Eye size={11} />}
              </button>
            </div>
            <button
              onClick={() => newKey.trim() && addKey.mutate(newKey.trim())}
              disabled={!newKey.trim() || addKey.isPending}
              aria-label="Add key"
              /* R126-3f-2: the add-key CTA = the QUIET-SOLID primary (the
                 brief's §4) — the accentDeep fill + the accentText ink on
                 the JS leg + the press collapse; the accent wash + the JS
                 accent color are retired. */
              className="ac-clay-pressed h-8 px-3 rounded-lg text-[11px] font-semibold flex items-center gap-1 bg-accent-deep transition-transform active:scale-[0.98] disabled:opacity-50 cursor-pointer"
              style={{ color: styles.accentText }}
            >
              <Plus size={11} strokeWidth={2.5} /> {addKey.isPending ? "Adding…" : "Add key"}
            </button>
          </div>
        )}
      </div>
      {/* Primary-editor status (save/copy confirmations + reveal failures).
          R126-3f-2: status TEXT = the §11 deep pairs on the class leg. */}
      {revealState.kind === "error" && (
        <p className="text-[11px] break-all text-danger-deep" role="alert">
          {revealState.message}
        </p>
      )}
      {keyStatus && (
        <p
          data-testid={keyStatusIsWarning ? "key-store-disclosure" : undefined}
          className={`text-[11px] ${
            saveKey.isError || keyStatusIsError
              ? "text-danger-deep"
              : keyStatusIsWarning
                ? "text-warning-deep"
                : "text-success-deep"
          }`}
        >
          {keyStatus}
        </p>
      )}
      {/* Pool add/remove status + reveal failures. */}
      {poolMsg && (
        <p
          className={`text-[11px] ${
            addKey.isError || removeKey.isError
              ? "text-danger-deep"
              : poolMsgIsWarning
                ? "text-warning-deep"
                : "text-success-deep"
          }`}
        >
          {poolMsg}
        </p>
      )}
      {revealError && (
        <p className="text-[11px] break-all text-danger-deep" role="alert">
          {revealError}
        </p>
      )}
      {/* A failed pool listing is honest — the primary editor still works,
          but Key 2..N cannot render from a lie. */}
      {poolQuery.isError && (
        <p className="text-[11px] text-danger-deep" role="alert">
          Key pool listing unavailable —{" "}
          {poolQuery.error instanceof Error ? poolQuery.error.message : String(poolQuery.error)}
        </p>
      )}
      <p className="text-[11px]" style={{ color: styles.textTertiary }}>
        Stored in the OS secure store — never in the database or logs; Show fetches the full
        value only on your explicit click.
      </p>
      {/* ROUND-47 (R47-c1): browser-dev honesty — the sidecar keyring is
          in-memory, so browser-stored keys do not survive a restart. */}
      {!isTauri() && (
        <p className="text-[11px]" style={{ color: styles.textTertiary, opacity: 0.75 }}>
          {EPHEMERAL_KEY_NOTE}
        </p>
      )}
    </SectionCard>
  );
}
