import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  Eye,
  EyeOff,
  Globe,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { withAlpha } from "../dashboard/helpers";
import { filterModelsForPicker, isFreeModelEntry, useSettingsStore } from "../../lib/settings-store";
import { isTauri } from "../../lib/sidecar";
import { nextFreeSlot } from "../../lib/key-pool";
import {
  createProvider,
  deleteProvider,
  deleteProviderModelConfig,
  fetchKeyPool,
  fetchProviderModelConfig,
  fetchProviderModels,
  fetchProviders,
  removeKeyPoolSlot,
  setKeyPoolSlot,
  storeProviderKey,
  testProviderConnection,
  updateProvider,
  updateProviderModelConfig,
  upsertProviderModelConfig,
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
 * So: ONE FLAT list of every provider (no built-in/custom groups, no nested
 * pick-a-vendor-inside-a-provider flow). "Add provider" opens a DIALOG that
 * first asks preset-or-custom, then takes name / base URL / API key / API
 * format. Every provider — presets included — is fully editable and
 * deletable (deleting a preset tombstones it so the boot seed doesn't
 * resurrect it; re-adding from the dialog clears the tombstone).
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

/* ── Component ────────────────────────────────────────────────────────────── */

export function ModelsProvidersTab() {
  const styles = useThemeStyles();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const providersQuery = useQuery({
    queryKey: ["settings-providers"],
    queryFn: () => fetchProviders(),
  });
  // ROUND-37: ONE flat list — every provider together, order = created.
  const providers = providersQuery.data ?? [];

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: ["settings-providers"] });

  const selected = useMemo(
    () => providers.find((p) => p.id === selectedId) ?? null,
    [providers, selectedId],
  );

  return (
    <div className="flex gap-4 min-h-[480px]">
      {/* ── LEFT: the FLAT provider list (ROUND-37: no groups) ─────────── */}
      <div
        className="w-[280px] shrink-0 rounded-[16px] border-[1.5px] overflow-hidden flex flex-col"
        style={{ background: styles.card, borderColor: styles.border }}
      >
        <div className="flex-1 overflow-y-auto auto-scroll p-1.5">
          {providers.length === 0 && (
            <div className="px-2.5 py-1.5 text-[11px]" style={{ color: styles.textTertiary }}>
              No providers — add one below.
            </div>
          )}
          {providers.map((p) => (
            <ProviderListRow
              key={p.id}
              provider={p}
              active={p.id === selectedId}
              onClick={() => setSelectedId(p.id)}
            />
          ))}
        </div>
        {/* + Add provider → the preset-or-custom DIALOG (owner R37) */}
        <div className="p-1.5 border-t" style={{ borderColor: styles.border }}>
          <button
            onClick={() => {
              setAdding(true);
              setSelectedId(null);
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

      {/* ── RIGHT: the detail panel ──────────────────────────────────────── */}
      <div className="flex-1 min-w-0">
        {selected ? (
          <ProviderDetailPane
            key={selected.id}
            provider={selected}
            onChanged={invalidate}
            onDeleted={() => {
              setSelectedId(null);
              invalidate();
            }}
          />
        ) : (
          <div className="h-full min-h-[480px] grid place-items-center rounded-[16px] border-[1.5px] border-dashed" style={{ borderColor: styles.border }}>
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
      style={{
        background: active ? withAlpha(styles.accent, 0.1) : "transparent",
      }}
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

/* ── Right detail pane (ROUND-37: EVERY provider fully editable) ──────────── */

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

  const [showKey, setShowKey] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [keyStatus, setKeyStatus] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(provider.name);
  const [baseUrlDraft, setBaseUrlDraft] = useState(provider.baseUrl ?? "");
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
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

  // ROUND-47 (R47-c1): the key-pool listing feeds the test key selector.
  // SAME query key as KeyPoolSection's — one shared cache entry per provider.
  const poolQuery = useQuery({
    queryKey: ["key-pool", provider.id],
    queryFn: () => fetchKeyPool(provider.id),
  });
  const heldPoolSlots = (poolQuery.data ?? [])
    .filter((k) => k.slot > 0 && k.hasKey)
    .map((k) => k.slot);

  // ROUND-47 (R47-c1): the provider's LIVE catalog — feeds the test model
  // selector AND ModelListSection (hoisted from there; same query key as
  // before so both keep sharing one cache entry). Fails soft — offline or
  // custom providers fall back to the configured rows only.
  const catalogQuery = useQuery({
    queryKey: ["settings-provider-models-catalog", provider.id],
    queryFn: () => fetchProviderModels(provider.id),
    retry: false,
  });
  const catalogIds = catalogQuery.data ?? [];

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
      setKeyInput("");
      setKeyStatus("Key saved to the secure store.");
      void queryClient.invalidateQueries({ queryKey: ["settings-providers"] });
    },
    onError: (err: Error) => setKeyStatus(err.message),
  });

  const saveDetails = useMutation({
    mutationFn: (patch: ProviderPatch) => updateProvider(provider.id, patch),
    onSuccess: () => {
      setSaveMsg("Saved.");
      setTimeout(() => setSaveMsg(null), 2000);
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

  const inputStyle = {
    background: styles.bg,
    borderColor: styles.border,
    color: styles.text,
  } as const;

  return (
    <div className="flex flex-col gap-4">
      {/* Header: name (editable for ALL) + Enabled badge + actions */}
      <div
        className="rounded-[16px] border-[1.5px] p-4 flex items-center gap-3 flex-wrap"
        style={{ background: styles.card, borderColor: styles.border }}
      >
        {editingName ? (
          <div className="flex items-center gap-2 flex-1 min-w-[200px]">
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
              className="h-9 flex-1 rounded-[10px] border-[1.5px] px-3 text-[14px] font-bold outline-none"
              style={inputStyle}
            />
          </div>
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
        <span className="flex-1" />
        {/* Enabled badge + Disable/Enable (every provider) */}
        <>
          <span
            className="px-2 py-0.5 rounded-full text-[10px] font-bold"
            style={{
              background: provider.enabled ? withAlpha("#22c55e", 0.12) : styles.subtle,
              color: provider.enabled ? "#22c55e" : styles.textTertiary,
            }}
          >
            {provider.enabled ? "● Enabled" : "○ Disabled"}
          </span>
          <button
            onClick={() => saveDetails.mutate({ enabled: !provider.enabled })}
            className="text-[11px] font-bold underline"
            style={{ color: styles.textSecondary }}
          >
            {provider.enabled ? "Disable" : "Enable"}
          </button>
          <button
            onClick={() => {
              if (confirmDelete) {
                removeProvider.mutate();
              } else {
                setConfirmDelete(true);
                setTimeout(() => setConfirmDelete(false), 3000);
              }
            }}
            aria-label={`Delete provider ${provider.name}`}
            title="Delete provider"
            className="h-7 px-2.5 rounded-[8px] text-[11px] font-bold flex items-center gap-1.5 transition-colors"
            style={
              confirmDelete
                ? { background: "#ef4444", color: "#fff" }
                : { color: styles.textTertiary }
            }
            onMouseEnter={(e) => {
              if (!confirmDelete) e.currentTarget.style.background = withAlpha("#ef4444", 0.12);
            }}
            onMouseLeave={(e) => {
              if (!confirmDelete) e.currentTarget.style.background = "transparent";
            }}
          >
            <Trash2 size={12} /> {confirmDelete ? "Confirm delete" : "Delete"}
          </button>
        </>
        {saveMsg && (
          <span className="text-[11px] font-bold" style={{ color: styles.accent }}>
            {saveMsg}
          </span>
        )}
      </div>

      {/* Connection card: base URL + api format + key + test */}
      <div
        className="rounded-[16px] border-[1.5px] p-4 flex flex-col gap-4"
        style={{ background: styles.card, borderColor: styles.border }}
      >
        <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: styles.textTertiary }}>
          Connection
        </span>
        {/* Base URL (editable for ALL — owner R37) */}
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
        {/* API key */}
        <div>
          <label className="mb-1.5 block text-[11px] font-bold" style={{ color: styles.textSecondary }}>
            API key {provider.hasKey && <span style={{ color: "#22c55e" }}>· stored</span>}
          </label>
          <div className="flex gap-2">
            <div className="relative flex-1 min-w-0">
              <input
                type={showKey ? "text" : "password"}
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                placeholder={provider.hasKey ? "A key is stored — enter a new one to rotate" : "sk-…"}
                aria-label="API key"
                className="h-10 w-full rounded-[10px] border-[1.5px] px-3 pr-10 font-mono text-[12px] outline-none"
                style={inputStyle}
              />
              <button
                onClick={() => setShowKey((v) => !v)}
                aria-label={showKey ? "Hide key" : "Show key"}
                title={showKey ? "Hide" : "Show"}
                className="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 grid place-items-center rounded-md"
                style={{ color: styles.textTertiary }}
              >
                {showKey ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            </div>
            <button
              onClick={() => keyInput.trim() && saveKey.mutate(keyInput.trim())}
              disabled={!keyInput.trim() || saveKey.isPending}
              className="h-10 px-4 rounded-[10px] text-[12px] font-bold disabled:opacity-50"
              style={{ background: styles.accent, color: styles.accentText }}
            >
              {saveKey.isPending ? "Saving…" : "Save key"}
            </button>
          </div>
          {keyStatus && (
            <p className="mt-1.5 text-[11px]" style={{ color: saveKey.isError ? "#ef4444" : "#22c55e" }}>
              {keyStatus}
            </p>
          )}
          <p className="mt-1 text-[10.5px]" style={{ color: styles.textTertiary }}>
            Stored in the OS secure store — never in the database or logs.
          </p>
          {/* ROUND-47 (R47-c1): browser-dev honesty — the sidecar keyring is
              in-memory, so browser-stored keys do not survive a restart. */}
          {!isTauri() && (
            <p className="mt-1 text-[10.5px]" style={{ color: styles.textTertiary, opacity: 0.75 }}>
              {EPHEMERAL_KEY_NOTE}
            </p>
          )}
        </div>
        {/* ── ROUND-36: the API key POOL (sub-agent keys) ─────────────── */}
        <KeyPoolSection providerId={provider.id} />

        {/* Test connection — ROUND-47 (R47-c1): WHICH key + WHICH model are
            explicit now (key selector over the primary + held pool slots,
            model selector over the live catalog; "(reachability only)" is
            the honest default — a cheap ping that does NOT prove the key). */}
        <div className="flex items-center gap-2.5 flex-wrap">
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
            disabled={catalogQuery.isFetching && catalogIds.length === 0}
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

      {/* Model list — ROUND-47 (R47-c1): the live catalog query lives in the
          detail pane now (the test model selector shares it); passed down. */}
      <ModelListSection
        providerId={provider.id}
        models={models}
        catalog={{
          ids: catalogIds,
          isFetching: catalogQuery.isFetching,
          isError: catalogQuery.isError,
        }}
      />
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
 * are editable; catalog-only entries render read-only until configured. */
interface MergedModel {
  /** Server models-table row id — null for catalog-only entries. */
  rowId: string | null;
  modelId: string;
  displayName: string;
  contextWindow: number | null;
  inputPricePerMtok: number | null;
  outputPricePerMtok: number | null;
  configured: boolean;
}

/** DB override rows enriched with live catalog ids (round-43: the list shows
 * the provider's real models so the free-only filter is meaningful). */
function mergeCatalogIntoModels(
  configured: ProviderModelConfig[],
  catalogIds: string[],
): MergedModel[] {
  const merged: MergedModel[] = configured.map((m) => ({
    rowId: m.id,
    modelId: m.modelId,
    displayName: m.displayName || m.modelId,
    contextWindow: m.contextWindow,
    inputPricePerMtok: m.inputPricePerMtok,
    outputPricePerMtok: m.outputPricePerMtok,
    configured: true,
  }));
  const seen = new Set(configured.map((m) => m.modelId));
  for (const id of catalogIds) {
    if (seen.has(id)) continue;
    merged.push({
      rowId: null,
      modelId: id,
      displayName: id,
      contextWindow: null,
      inputPricePerMtok: null,
      outputPricePerMtok: null,
      configured: false,
    });
  }
  return merged;
}

/** The provider's LIVE catalog, passed down from the detail pane (ROUND-47
 * R47-c1: hoisted so the connection-test model selector shares the query). */
interface ProviderCatalogState {
  ids: string[];
  isFetching: boolean;
  isError: boolean;
}

function ModelListSection({
  providerId,
  models,
  catalog,
}: {
  providerId: string;
  models: ProviderModelConfig[];
  catalog: ProviderCatalogState;
}) {
  const styles = useThemeStyles();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [newModelId, setNewModelId] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState({ displayName: "", contextWindow: "" });
  const [error, setError] = useState<string | null>(null);

  // ROUND-43 (owner: "free-only model filter"): shared persisted pref — the
  // chat composer picker honors the same store in a later wave.
  const modelsFreeOnly = useSettingsStore((s) => s.modelsFreeOnly);
  const setModelsFreeOnly = useSettingsStore((s) => s.setModelsFreeOnly);

  // The live catalog arrives as a prop now (same route the chat picker uses;
  // fails soft — offline/custom providers fall back to the configured rows).
  const catalogIds = catalog.ids;

  const merged = mergeCatalogIntoModels(models, catalogIds);
  const visible = filterModelsForPicker(merged, modelsFreeOnly);
  const freeCount = filterModelsForPicker(merged, true).length;

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: ["settings-provider-models", providerId] });

  const addModel = useMutation({
    mutationFn: () =>
      upsertProviderModelConfig(providerId, {
        modelId: newModelId.trim(),
        ...(newDisplayName.trim() ? { displayName: newDisplayName.trim() } : {}),
      }),
    onSuccess: () => {
      setAdding(false);
      setNewModelId("");
      setNewDisplayName("");
      setError(null);
      invalidate();
    },
    onError: (err: Error) => setError(err.message),
  });

  const updateModel = useMutation({
    // Only invoked from the edit row, where editingId is the row's id — the
    // guard keeps the promise typed without inventing a "/models/null" URL.
    mutationFn: (patch: ProviderModelConfigPatch) =>
      editingId === null
        ? Promise.reject(new Error("no model row is being edited"))
        : updateProviderModelConfig(editingId, patch),
    onSuccess: () => {
      setEditingId(null);
      invalidate();
    },
    onError: (err: Error) => setError(err.message),
  });

  const deleteModel = useMutation({
    mutationFn: (id: string) => deleteProviderModelConfig(id),
    onSuccess: invalidate,
    onError: (err: Error) => setError(err.message),
  });

  return (
    <div className="rounded-[16px] border-[1.5px] overflow-hidden" style={{ background: styles.card, borderColor: styles.border }}>
      <div className="flex items-center gap-2 px-4 py-3 border-b flex-wrap" style={{ borderColor: styles.border }}>
        <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: styles.textTertiary }}>
          Models ({modelsFreeOnly ? `${freeCount} free of ${merged.length}` : `${merged.length}`})
        </span>
        <span className="flex-1" />
        {/* ROUND-43 (owner directive): "Free only | All models" — free is the
            default; persisted in the shared settings store so the chat model
            picker honors the same choice. */}
        <div
          role="group"
          aria-label="Model filter"
          className="flex items-center rounded-[10px] border-[1.5px] overflow-hidden"
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
        <button
          onClick={() => setAdding((v) => !v)}
          className="h-7 px-2.5 rounded-full text-[11px] font-bold flex items-center gap-1"
          style={{ background: withAlpha(styles.accent, 0.1), color: styles.accent }}
        >
          <Plus size={11} strokeWidth={2.5} /> Add model
        </button>
      </div>

      {adding && (
        <div className="px-4 py-3 border-b flex flex-col gap-2" style={{ borderColor: styles.border, background: withAlpha(styles.accent, 0.03) }}>
          <div className="flex gap-2 flex-wrap">
            <input
              autoFocus
              value={newModelId}
              onChange={(e) => setNewModelId(e.target.value)}
              placeholder="model id, e.g. openai/gpt-4o-mini"
              aria-label="Model id"
              className="h-9 flex-1 min-w-[200px] rounded-[10px] border-[1.5px] px-3 font-mono text-[12px] outline-none"
              style={{ background: styles.bg, borderColor: styles.border, color: styles.text }}
            />
            <input
              value={newDisplayName}
              onChange={(e) => setNewDisplayName(e.target.value)}
              placeholder="display name (optional)"
              aria-label="Display name"
              className="h-9 flex-1 min-w-[160px] rounded-[10px] border-[1.5px] px-3 text-[12px] outline-none"
              style={{ background: styles.bg, borderColor: styles.border, color: styles.text }}
            />
            <button
              onClick={() => addModel.mutate()}
              disabled={!newModelId.trim() || addModel.isPending}
              className="h-9 px-3.5 rounded-[10px] text-[12px] font-bold disabled:opacity-50"
              style={{ background: styles.accent, color: styles.accentText }}
            >
              Add
            </button>
            <button
              onClick={() => setAdding(false)}
              aria-label="Cancel add model"
              className="w-9 h-9 grid place-items-center rounded-[10px]"
              style={{ color: styles.textTertiary }}
            >
              <X size={13} />
            </button>
          </div>
          {error && <p className="text-[11px]" style={{ color: "#ef4444" }}>{error}</p>}
        </div>
      )}

      {merged.length === 0 && !adding ? (
        <div className="px-4 py-6 text-center text-[12px]" style={{ color: styles.textTertiary }}>
          {catalog.isFetching
            ? "Fetching the provider catalog…"
            : catalog.isError
              ? "No models configured and the live catalog is unreachable — add entries by hand."
              : "No models configured — fetched catalog models appear in pickers automatically; add entries here to override pricing or context size."}
        </div>
      ) : visible.length === 0 && !adding ? (
        <div className="px-4 py-6 text-center text-[12px]" style={{ color: styles.textTertiary }}>
          No free models on this provider — switch to “All models” to see the full list.
        </div>
      ) : (
        <div className="max-h-72 overflow-y-auto auto-scroll">
          {visible.map((m) => (
            <div
              key={m.rowId ?? `cat:${m.modelId}`}
              className="flex items-center gap-3 px-4 py-2.5 border-b last:border-b-0"
              style={{ borderColor: styles.borderSubtle }}
            >
              {editingId === m.rowId ? (
                <>
                  <input
                    autoFocus
                    value={editDraft.displayName}
                    onChange={(e) => setEditDraft((d) => ({ ...d, displayName: e.target.value }))}
                    aria-label="Model display name"
                    className="h-8 flex-1 min-w-0 rounded-[8px] border-[1.5px] px-2.5 text-[12px] outline-none"
                    style={{ background: styles.bg, borderColor: styles.border, color: styles.text }}
                  />
                  <input
                    value={editDraft.contextWindow}
                    onChange={(e) => setEditDraft((d) => ({ ...d, contextWindow: e.target.value }))}
                    placeholder="ctx"
                    aria-label="Context window tokens"
                    className="h-8 w-24 rounded-[8px] border-[1.5px] px-2.5 font-mono text-[11px] outline-none"
                    style={{ background: styles.bg, borderColor: styles.border, color: styles.text }}
                  />
                  <button
                    onClick={() => {
                      const patch: ProviderModelConfigPatch = {};
                      if (editDraft.displayName.trim()) patch.displayName = editDraft.displayName.trim();
                      const ctx = Number(editDraft.contextWindow);
                      if (Number.isInteger(ctx) && ctx > 0) patch.contextWindow = ctx;
                      updateModel.mutate(patch);
                    }}
                    className="w-7 h-7 grid place-items-center rounded-[8px]"
                    style={{ background: withAlpha("#22c55e", 0.12), color: "#22c55e" }}
                    aria-label="Save model"
                  >
                    <Check size={12} />
                  </button>
                  <button
                    onClick={() => setEditingId(null)}
                    className="w-7 h-7 grid place-items-center rounded-[8px]"
                    style={{ color: styles.textTertiary }}
                    aria-label="Cancel edit"
                  >
                    <X size={12} />
                  </button>
                </>
              ) : (
                <>
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-[12px]"
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
                  {m.contextWindow !== null && (
                    <span
                      className="shrink-0 px-1.5 py-0.5 rounded-full font-mono text-[10px]"
                      style={{ background: styles.subtle, color: styles.textTertiary }}
                    >
                      {m.contextWindow >= 1_000_000 ? `${m.contextWindow / 1_000_000}M ctx` : `${Math.round(m.contextWindow / 1000)}k ctx`}
                    </span>
                  )}
                  {m.inputPricePerMtok !== null && (
                    <span className="shrink-0 font-mono text-[10px]" style={{ color: styles.textTertiary }}>
                      ${m.inputPricePerMtok}/${m.outputPricePerMtok ?? 0} per 1M
                    </span>
                  )}
                  {!m.configured && (
                    <span
                      className="shrink-0 px-1.5 py-0.5 rounded-full font-mono text-[10px]"
                      style={{ background: styles.subtle, color: styles.textTertiary }}
                      title="Live catalog entry — use “Add model” to create a pricing/context override"
                    >
                      catalog
                    </span>
                  )}
                  {m.configured && m.rowId !== null && (
                    <>
                      <button
                        onClick={() => {
                          setEditingId(m.rowId);
                          setEditDraft({
                            displayName: m.displayName,
                            contextWindow: m.contextWindow !== null ? String(m.contextWindow) : "",
                          });
                        }}
                        aria-label={`Edit model ${m.displayName || m.modelId}`}
                        title="Edit"
                        className="w-7 h-7 grid place-items-center rounded-[8px] shrink-0"
                        style={{ color: styles.textTertiary }}
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
                    </>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── New provider pane (the "+ Add provider" draft) ───────────────────────── */

/* ── ROUND-36 (ADR-0022): the per-provider API key pool ───────────────────── */

/** Exported for the ROUND-47 (R47-c1) regression test — the slot-collision
 * fix lives in the add-slot mutation below. */
export function KeyPoolSection({ providerId }: { providerId: string }) {
  const styles = useThemeStyles();
  const queryClient = useQueryClient();
  const [newKey, setNewKey] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

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
      setTimeout(() => setMsg(null), 1500);
      invalidate();
    },
    onError: (err: Error) => setMsg(err.message),
  });

  const removeSlot = useMutation({
    mutationFn: (slot: number) => removeKeyPoolSlot(providerId, slot),
    onSuccess: invalidate,
    onError: (err: Error) => setMsg(err.message),
  });

  return (
    <div>
      <label className="mb-1.5 block text-[11px] font-bold" style={{ color: styles.textSecondary }}>
        API key pool <span style={{ color: styles.textTertiary }}>— dedicated keys for sub-agents (primary stays free)</span>
      </label>
      <div className="rounded-[10px] border-[1.5px] overflow-hidden" style={{ borderColor: styles.border }}>
        {slots.length === 0 && (
          <div className="px-3 py-2.5 text-[11px]" style={{ color: styles.textTertiary }}>
            No pool slots — sub-agents share the primary key (rate-limited by the per-key setting).
          </div>
        )}
        {slots.map((k) => (
          <div key={k.slot} className="flex items-center gap-2 px-3 py-2 border-b last:border-b-0" style={{ borderColor: styles.borderSubtle }}>
            <span className="text-[11px] font-mono font-bold shrink-0" style={{ color: styles.textSecondary }}>
              SLOT {k.slot}
            </span>
            <span className="font-mono text-[11px] flex-1 min-w-0 truncate" style={{ color: styles.textTertiary }}>
              {k.masked ?? "—"}
            </span>
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
        ))}
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
