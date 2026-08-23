/**
 * Models & Providers settings tab (round-19 owner request).
 * Full provider + model management: add preset/custom providers,
 * view/copy/edit API keys, model list with pricing/context/testing/hiding.
 */
import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  ChevronDown, Copy, Check, Edit2, Eye, EyeOff, Plus, Server, Trash2, Zap, RefreshCw,
} from "lucide-react";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { withAlpha } from "../dashboard/helpers";
import { useConfigStore } from "../../lib/config-store";

export interface ModelRecord {
  id: string; providerId: string; modelId: string; displayName: string;
  contextWindow: number | null; maxOutputTokens: number | null;
  inputPricePerMtok: number | null; inputPriceCachedPerMtok: number | null;
  outputPricePerMtok: number | null; supportsThinking: boolean;
  hidden: boolean; sortOrder: number; createdAt: string; updatedAt: string;
}
export interface ProviderView {
  id: string; name: string; kind: string; baseUrl: string | null;
  apiFormat?: string; enabled: boolean; createdAt: string; hasKey: boolean;
}
type ApiFormat = "chat-completions" | "anthropic-messages" | "responses";

function useApi() {
  const { baseUrl, token } = useConfigStore.getState();
  return useCallback(async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const res = await fetch(`${baseUrl}/api/v1${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init?.headers ?? {}) },
    });
    if (res.status === 204) return undefined as T;
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
    return body as T;
  }, [baseUrl, token]);
}

export function ModelsProvidersTab() {
  const styles = useThemeStyles();
  const api = useApi();
  const queryClient = useQueryClient();
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);

  const providersQuery = useQuery({
    queryKey: ["settings.providers"],
    queryFn: () => api<{ providers: ProviderView[] }>("/providers"),
    staleTime: 30_000,
  });
  const providers = providersQuery.data?.providers ?? [];
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["settings.providers"] });
    void queryClient.invalidateQueries({ queryKey: ["provider-models-config"] });
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-[12px] leading-relaxed" style={{ color: styles.textSecondary }}>
          Manage providers, API keys, and model configurations.
        </p>
        <button onClick={() => setShowAddDialog(true)}
          className="flex items-center gap-1.5 rounded-lg border-[1.5px] px-3 py-2 text-[12px] font-semibold transition-all active:scale-95"
          style={{ background: styles.accent, color: styles.accentText, borderColor: styles.accent }}>
          <Plus size={13} /> Add Provider
        </button>
      </div>
      {providersQuery.isError && (
        <div role="alert" className="rounded-lg border-[1.5px] px-3 py-2 text-[11px]"
          style={{ borderColor: withAlpha("#D64545", 0.4), color: "#D64545" }}>
          Agent core unreachable — run the app to configure providers.
        </div>
      )}
      {providers.map((p) => (
        <ProviderCard key={p.id} provider={p} api={api}
          expanded={expandedProvider === p.id}
          onToggle={() => setExpandedProvider(expandedProvider === p.id ? null : p.id)}
          onInvalidate={invalidate} />
      ))}
      {showAddDialog && <AddProviderDialog api={api} onClose={() => setShowAddDialog(false)} onCreated={invalidate} />}
    </div>
  );
}

function ProviderCard({ provider, api, expanded, onToggle, onInvalidate }: {
  provider: ProviderView; api: <T>(p: string, i?: RequestInit) => Promise<T>;
  expanded: boolean; onToggle: () => void; onInvalidate: () => void;
}) {
  const styles = useThemeStyles();
  const [showKey, setShowKey] = useState(false);
  const [keyValue, setKeyValue] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState(""); const [showKeyInput, setShowKeyInput] = useState(false);
  const [editingKey, setEditingKey] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showAddModel, setShowAddModel] = useState(false);
  const [testingModel, setTestingModel] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const modelsQuery = useQuery({
    queryKey: ["provider-models-config", provider.id],
    queryFn: () => api<{ models: ModelRecord[] }>(`/providers/${provider.id}/models-config`),
    enabled: expanded,
  });

  const fetchKey = async () => {
    setShowKey(true);
    try {
      const r = await api<{ hasKey: boolean; key: string | null }>(`/providers/${provider.id}/key`);
      setKeyValue(r.key);
    } catch { setKeyValue(null); }
  };
  const [keyError, setKeyError] = useState<string | null>(null);
  const saveKey = async () => {
    if (keyInput.trim().length <= 6) { setKeyError("Key must be at least 7 characters"); return; }
    setKeyError(null);
    try {
      await api(`/providers/${provider.id}/key`, { method: "PUT", body: JSON.stringify({ value: keyInput.trim() }) });
      setKeyInput(""); setEditingKey(false); setKeyValue(keyInput.trim()); setKeyError(null);
      onInvalidate();
    } catch (e) {
      setKeyError(e instanceof Error ? e.message : "Failed to save key");
    }
  };
  const testModel = async (mid: string) => {
    setTestingModel(mid); setTestResult(null);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      const r = await api<{ ok: boolean; message?: string; latencyMs?: number }>(
        `/providers/${provider.id}/test`, { method: "POST", body: JSON.stringify({ model: mid }), signal: controller.signal });
      clearTimeout(timer);
      setTestResult({ ok: r.ok, message: r.ok ? `${r.latencyMs}ms` : r.message ?? "failed" });
    } catch (e) {
      const msg = e instanceof DOMException && e.name === "AbortError"
        ? "timeout (30s) — provider unreachable"
        : e instanceof Error ? e.message : "error";
      setTestResult({ ok: false, message: msg });
    } finally { setTestingModel(null); }
  };

  const models = modelsQuery.data?.models ?? [];
  const visible = models.filter((m) => !m.hidden);
  const hidden = models.filter((m) => m.hidden);
  const is = { background: styles.inputBg, borderColor: styles.inputBorder, color: styles.text } as const;

  return (
    <div className="rounded-[16px] border-[1.5px]" style={{ background: styles.card, borderColor: styles.border }}>
      <button onClick={onToggle} className="flex w-full items-center gap-3 px-4 py-3 text-left">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl text-[13px] font-bold"
          style={{ background: withAlpha(styles.accent, 0.15), color: styles.accent }}>
          {provider.name.charAt(0).toUpperCase()}
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="text-[14px] font-bold" style={{ color: styles.text }}>{provider.name}</span>
          <span className="rounded-md px-1.5 py-0.5 text-[9px] font-mono"
            style={{ background: styles.subtle, color: styles.textTertiary }}>
            {provider.apiFormat ?? "chat-completions"}
          </span>
          <span className="text-[10px]" style={{ color: provider.hasKey ? "#22c55e" : "#ef4444" }}>
            {provider.hasKey ? "● keyed" : "○ no key"}
          </span>
        </div>
        <span className="text-[11px] font-mono" style={{ color: styles.textTertiary }}>
          {visible.length}/{models.length} models
        </span>
        <motion.span animate={{ rotate: expanded ? 180 : 0 }} transition={{ duration: 0.15 }}>
          <ChevronDown size={14} style={{ color: styles.textSecondary }} />
        </motion.span>
      </button>

      {expanded && (
        <div className="border-t-[1.5px] px-4 py-4" style={{ borderColor: styles.border }}>
          <div className="mb-4">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: styles.textSecondary }}>API Key</span>
              <button onClick={() => (showKey ? setShowKey(false) : void fetchKey())}
                className="flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-semibold"
                style={{ background: styles.subtle, color: styles.textSecondary }}>
                {showKey ? <EyeOff size={10} /> : <Eye size={10} />} {showKey ? "Hide" : "View"}
              </button>
              {showKey && keyValue && (
                <button onClick={() => { void navigator.clipboard?.writeText(keyValue); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
                  className="flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-semibold"
                  style={{ background: styles.subtle, color: styles.textSecondary }}>
                  {copied ? <Check size={10} /> : <Copy size={10} />} {copied ? "Copied" : "Copy"}
                </button>
              )}
              <button onClick={() => setEditingKey(!editingKey)}
                className="rounded-md px-2 py-1 text-[10px] font-semibold"
                style={{ background: styles.subtle, color: styles.textSecondary }}>
                {editingKey ? "Cancel" : "Edit"}
              </button>
            </div>
            {showKey && keyValue && !editingKey && (
              <code className="block truncate rounded-lg px-3 py-2 font-mono text-[11px]"
                style={{ background: styles.inputBg, color: styles.text }}>{keyValue}</code>
            )}
            {editingKey && (
              <div className="flex flex-col gap-1.5">
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <input value={keyInput} onChange={(e) => { setKeyInput(e.target.value); setKeyError(null); }}
                      placeholder={provider.hasKey ? "Enter new key to replace…" : "Enter API key…"}
                      type={showKeyInput ? "text" : "password"}
                      className="h-9 w-full rounded-lg border-[1.5px] px-3 pr-9 font-mono text-[11px] outline-none" style={is} />
                    <button type="button" onClick={() => setShowKeyInput(!showKeyInput)}
                      className="absolute right-2 top-1/2 -translate-y-1/2" style={{ color: styles.textSecondary }}>
                      {showKeyInput ? <EyeOff size={11} /> : <Eye size={11} />}
                    </button>
                  </div>
                  <button onClick={() => void saveKey()} disabled={keyInput.trim().length <= 6}
                    className="shrink-0 rounded-lg px-3 py-2 text-[11px] font-semibold disabled:opacity-50"
                    style={{ background: styles.accent, color: styles.accentText }}>Save</button>
                </div>
                {keyError && <p className="text-[10px]" style={{ color: "#ef4444" }}>{keyError}</p>}
              </div>
            )}
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: styles.textSecondary }}>
                Models ({models.length})
              </span>
              <button onClick={() => setShowAddModel(true)}
                className="flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-semibold"
                style={{ background: withAlpha(styles.accent, 0.1), color: styles.accent }}>
                <Plus size={10} /> Add Model
              </button>
            </div>
            {modelsQuery.isLoading ? (
              <p className="py-4 text-center text-[11px]" style={{ color: styles.textTertiary }}>Loading models…</p>
            ) : models.length === 0 ? (
              <p className="py-4 text-center text-[11px]" style={{ color: styles.textTertiary }}>
                No models configured — add one above.
              </p>
            ) : (
              <div className="flex flex-col gap-1">
                {visible.map((m) => (
                  <ModelRow key={m.id} model={m} api={api} onTest={() => void testModel(m.modelId)}
                    testing={testingModel === m.modelId}
                    testResult={testingModel === m.modelId ? testResult : null} onInvalidate={onInvalidate} />
                ))}
                {hidden.length > 0 && (
                  <>
                    <div className="mt-2 mb-1 text-[9px] font-bold uppercase tracking-widest" style={{ color: styles.textTertiary }}>
                      Hidden ({hidden.length})
                    </div>
                    {hidden.map((m) => (
                      <ModelRow key={m.id} model={m} api={api} onTest={() => void testModel(m.modelId)}
                        testing={testingModel === m.modelId}
                        testResult={testingModel === m.modelId ? testResult : null} onInvalidate={onInvalidate} />
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
          {showAddModel && (
            <AddModelDialog providerId={provider.id} api={api}
              onClose={() => setShowAddModel(false)} onCreated={onInvalidate} />
          )}
        </div>
      )}
    </div>
  );
}

function ModelRow({ model, api, onTest, testing, testResult, onInvalidate }: {
  model: ModelRecord; api: <T>(p: string, i?: RequestInit) => Promise<T>;
  onTest: () => void; testing: boolean;
  testResult: { ok: boolean; message: string } | null; onInvalidate: () => void;
}) {
  const styles = useThemeStyles();
  const [showEdit, setShowEdit] = useState(false);
  const toggleHidden = async () => {
    try { await api(`/models/${model.id}`, { method: "PATCH", body: JSON.stringify({ hidden: !model.hidden }) }); onInvalidate(); } catch {}
  };
  const del = async () => {
    try { await api(`/models/${model.id}`, { method: "DELETE" }); onInvalidate(); } catch {}
  };
  return (
    <div className="flex items-center gap-2 rounded-xl border-[1.5px] px-3 py-2"
      style={{ background: model.hidden ? styles.subtle : styles.inputBg, borderColor: styles.border, opacity: model.hidden ? 0.6 : 1 }}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[12px] font-mono font-medium" style={{ color: styles.text }}>
            {model.displayName || model.modelId}
          </span>
          {model.contextWindow != null && (
            <span className="shrink-0 rounded-md px-1.5 py-0.5 text-[9px] font-mono"
              style={{ background: styles.subtle, color: styles.textTertiary }}>
              {(model.contextWindow / 1000).toFixed(0)}k
            </span>
          )}
        </div>
        {model.modelId !== model.displayName && (
          <span className="truncate text-[10px] font-mono" style={{ color: styles.textTertiary }}>{model.modelId}</span>
        )}
      </div>
      {testResult && (
        <span className="shrink-0 rounded-md px-2 py-0.5 text-[9px] font-mono font-bold"
          style={{ color: testResult.ok ? "#22c55e" : "#ef4444", background: testResult.ok ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)" }}>
          {testResult.ok ? `✓ ${testResult.message}` : `✗ ${testResult.message}`}
        </span>
      )}
      <button onClick={onTest} disabled={testing} title="Test model"
        className="grid h-6 w-6 shrink-0 place-items-center rounded-md disabled:opacity-50" style={{ color: styles.textSecondary }}>
        {testing ? <RefreshCw size={11} className="animate-spin" /> : <Zap size={11} />}
      </button>
      <button onClick={() => setShowEdit(true)} title="Edit model"
        className="grid h-6 w-6 shrink-0 place-items-center rounded-md" style={{ color: styles.textSecondary }}>
        <Edit2 size={11} />
      </button>
      <button onClick={() => void toggleHidden()} title={model.hidden ? "Unhide" : "Hide from chat"}
        className="grid h-6 w-6 shrink-0 place-items-center rounded-md" style={{ color: model.hidden ? styles.accent : styles.textSecondary }}>
        {model.hidden ? <EyeOff size={11} /> : <Eye size={11} />}
      </button>
      <button onClick={() => void del()} title="Delete"
        className="grid h-6 w-6 shrink-0 place-items-center rounded-md" style={{ color: styles.textSecondary }}>
        <Trash2 size={11} />
      </button>
      {showEdit && (
        <EditModelDialog model={model} api={api}
          onClose={() => setShowEdit(false)} onSaved={onInvalidate} />
      )}
    </div>
  );
}

function AddProviderDialog({ api, onClose, onCreated }: {
  api: <T>(p: string, i?: RequestInit) => Promise<T>; onClose: () => void; onCreated: () => void;
}) {
  const styles = useThemeStyles();
  const [mode, setMode] = useState<"choose" | "preset" | "custom">("choose");
  const [name, setName] = useState(""); const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState(""); const [showApiKey, setShowApiKey] = useState(false); const [apiFormat, setApiFormat] = useState<ApiFormat>("chat-completions");
  const [error, setError] = useState<string | null>(null); const [creating, setCreating] = useState(false);
  const is = { background: styles.inputBg, borderColor: styles.inputBorder, color: styles.text } as const;

  const createCustom = async () => {
    if (!name.trim() || !baseUrl.trim() || creating) return;
    setCreating(true); setError(null);
    try {
      await api("/providers", { method: "POST", body: JSON.stringify({ name: name.trim(), baseUrl: baseUrl.trim(), apiFormat }) });
      onCreated(); onClose();
    } catch (e) { setError(e instanceof Error ? e.message : "Failed"); } finally { setCreating(false); }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center" style={{ background: "rgba(0,0,0,0.5)" }} onClick={onClose}>
      <div className="w-[min(480px,92vw)] rounded-[16px] border-[1.5px] p-5"
        style={{ background: styles.card, borderColor: styles.borderStrong }} onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-4 text-[16px] font-bold" style={{ color: styles.text }}>Add Provider</h3>
        {mode === "choose" && (
          <div className="flex flex-col gap-3">
            <button onClick={() => setMode("preset")}
              className="rounded-xl border-[1.5px] p-4 text-left transition-all hover:scale-[1.01]"
              style={{ background: styles.inputBg, borderColor: styles.border }}>
              <div className="flex items-center gap-2"><Server size={16} style={{ color: styles.accent }} />
                <span className="text-[14px] font-bold" style={{ color: styles.text }}>Select from presets</span></div>
              <p className="mt-1 text-[11px]" style={{ color: styles.textSecondary }}>OpenRouter — models auto-configured</p>
            </button>
            <button onClick={() => setMode("custom")}
              className="rounded-xl border-[1.5px] p-4 text-left transition-all hover:scale-[1.01]"
              style={{ background: styles.inputBg, borderColor: styles.border }}>
              <div className="flex items-center gap-2"><Plus size={16} style={{ color: styles.accent }} />
                <span className="text-[14px] font-bold" style={{ color: styles.text }}>Add custom provider</span></div>
              <p className="mt-1 text-[11px]" style={{ color: styles.textSecondary }}>OpenAI-compatible, Anthropic, or Responses API</p>
            </button>
          </div>
        )}
        {mode === "custom" && (
          <div className="flex flex-col gap-3">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Provider name"
              className="h-10 w-full rounded-lg border-[1.5px] px-3 text-[13px] outline-none" style={is} autoFocus />
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1"
              className="h-10 w-full rounded-lg border-[1.5px] px-3 font-mono text-[12px] outline-none" style={is} />
            <div className="relative">
              <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="API key"
                type={showApiKey ? "text" : "password"}
                className="h-10 w-full rounded-lg border-[1.5px] px-3 pr-10 font-mono text-[12px] outline-none" style={is} />
              <button type="button" onClick={() => setShowApiKey(!showApiKey)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1"
                style={{ color: styles.textSecondary }}
                aria-label={showApiKey ? "Hide API key" : "Show API key"}>
                {showApiKey ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            </div>
            <div className="flex gap-2">
              {(["chat-completions", "anthropic-messages", "responses"] as const).map((f) => (
                <button key={f} onClick={() => setApiFormat(f)}
                  className="flex-1 rounded-lg border-[1.5px] px-2 py-2 text-[10px] font-semibold"
                  style={{ background: apiFormat === f ? styles.accent : styles.inputBg,
                           color: apiFormat === f ? styles.accentText : styles.textSecondary,
                           borderColor: apiFormat === f ? styles.accent : styles.border }}>
                  {f === "chat-completions" ? "Chat Completions" : f === "anthropic-messages" ? "Anthropic" : "Responses"}
                </button>
              ))}
            </div>
            {error && <p className="text-[11px]" style={{ color: "#ef4444" }}>{error}</p>}
            <div className="mt-2 flex gap-2">
              <button onClick={() => setMode("choose")} className="flex-1 rounded-lg border-[1.5px] py-2.5 text-[12px] font-semibold"
                style={{ background: styles.inputBg, color: styles.textSecondary, borderColor: styles.border }}>Back</button>
              <button onClick={() => void createCustom()} disabled={!name.trim() || !baseUrl.trim() || creating}
                className="flex-1 rounded-lg py-2.5 text-[12px] font-semibold disabled:opacity-50"
                style={{ background: styles.accent, color: styles.accentText }}>
                {creating ? "Creating…" : "Create Provider"}
              </button>
            </div>
          </div>
        )}
        {mode === "preset" && (
          <div className="flex flex-col gap-3">
            <p className="text-[12px]" style={{ color: styles.textSecondary }}>
              Preset providers come with pre-configured base URLs and auto-fetched model lists.
            </p>
            <div className="rounded-xl border-[1.5px] p-4" style={{ background: styles.inputBg, borderColor: styles.border }}>
              <div className="flex items-center gap-2">
                <span className="grid h-8 w-8 place-items-center rounded-xl text-[13px] font-bold"
                  style={{ background: withAlpha(styles.accent, 0.15), color: styles.accent }}>O</span>
                <span className="text-[14px] font-bold" style={{ color: styles.text }}>OpenRouter</span>
              </div>
              <p className="mt-1 font-mono text-[10px]" style={{ color: styles.textTertiary }}>https://openrouter.ai/api/v1</p>
            </div>
            <button onClick={onClose} className="rounded-lg border-[1.5px] py-2.5 text-[12px] font-semibold"
              style={{ background: styles.inputBg, color: styles.textSecondary, borderColor: styles.border }}>
              Close — OpenRouter is already configured
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function AddModelDialog({ providerId, api, onClose, onCreated }: {
  providerId: string; api: <T>(p: string, i?: RequestInit) => Promise<T>;
  onClose: () => void; onCreated: () => void;
}) {
  const styles = useThemeStyles();
  const [modelId, setModelId] = useState(""); const [displayName, setDisplayName] = useState("");
  const [contextWindow, setContextWindow] = useState(""); const [maxOutput, setMaxOutput] = useState("");
  const [inputPrice, setInputPrice] = useState(""); const [cachedPrice, setCachedPrice] = useState("");
  const [outputPrice, setOutputPrice] = useState("");
  const [error, setError] = useState<string | null>(null); const [creating, setCreating] = useState(false);
  const is = { background: styles.inputBg, borderColor: styles.inputBorder, color: styles.text } as const;
  const small = "h-9 w-full rounded-lg border-[1.5px] px-2.5 text-[12px] font-mono outline-none";

  const create = async () => {
    if (!modelId.trim() || creating) return;
    setCreating(true); setError(null);
    try {
      await api(`/providers/${providerId}/models`, { method: "POST", body: JSON.stringify({
        modelId: modelId.trim(), displayName: displayName.trim() || modelId.trim(),
        ...(contextWindow ? { contextWindow: Number(contextWindow) } : {}),
        ...(maxOutput ? { maxOutputTokens: Number(maxOutput) } : {}),
        ...(inputPrice ? { inputPricePerMtok: Number(inputPrice) } : {}),
        ...(cachedPrice ? { inputPriceCachedPerMtok: Number(cachedPrice) } : {}),
        ...(outputPrice ? { outputPricePerMtok: Number(outputPrice) } : {}),
      }) });
      onCreated(); onClose();
    } catch (e) { setError(e instanceof Error ? e.message : "Failed"); } finally { setCreating(false); }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center" style={{ background: "rgba(0,0,0,0.5)" }} onClick={onClose}>
      <div className="max-h-[85vh] w-[min(440px,92vw)] overflow-y-auto rounded-[16px] border-[1.5px] p-5"
        style={{ background: styles.card, borderColor: styles.borderStrong }} onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-4 text-[16px] font-bold" style={{ color: styles.text }}>Add Model</h3>
        <div className="flex flex-col gap-3">
          <input value={modelId} onChange={(e) => setModelId(e.target.value)}
            placeholder="Model ID (e.g. anthropic/claude-sonnet-4)"
            className={small} style={is} autoFocus />
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Display name" className={small} style={is} />
          <div className="grid grid-cols-2 gap-2">
            <input value={contextWindow} onChange={(e) => setContextWindow(e.target.value.replace(/[^0-9]/g, ""))}
              placeholder="Context window" className={small} style={is} inputMode="numeric" />
            <input value={maxOutput} onChange={(e) => setMaxOutput(e.target.value.replace(/[^0-9]/g, ""))}
              placeholder="Max output tokens" className={small} style={is} inputMode="numeric" />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <input value={inputPrice} onChange={(e) => setInputPrice(e.target.value.replace(/[^0-9.]/g, ""))}
              placeholder="$/Mt in" className={small} style={is} inputMode="decimal" />
            <input value={cachedPrice} onChange={(e) => setCachedPrice(e.target.value.replace(/[^0-9.]/g, ""))}
              placeholder="$/Mt cached" className={small} style={is} inputMode="decimal" />
            <input value={outputPrice} onChange={(e) => setOutputPrice(e.target.value.replace(/[^0-9.]/g, ""))}
              placeholder="$/Mt out" className={small} style={is} inputMode="decimal" />
          </div>
          {error && <p className="text-[11px]" style={{ color: "#ef4444" }}>{error}</p>}
          <div className="mt-1 flex gap-2">
            <button onClick={onClose} className="flex-1 rounded-lg border-[1.5px] py-2.5 text-[12px] font-semibold"
              style={{ background: styles.inputBg, color: styles.textSecondary, borderColor: styles.border }}>Cancel</button>
            <button onClick={() => void create()} disabled={!modelId.trim() || creating}
              className="flex-1 rounded-lg py-2.5 text-[12px] font-semibold disabled:opacity-50"
              style={{ background: styles.accent, color: styles.accentText }}>
              {creating ? "Adding…" : "Add Model"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function EditModelDialog({ model, api, onClose, onSaved }: {
  model: ModelRecord;
  api: <T>(p: string, i?: RequestInit) => Promise<T>;
  onClose: () => void; onSaved: () => void;
}) {
  const styles = useThemeStyles();
  const [displayName, setDisplayName] = useState(model.displayName);
  const [contextWindow, setContextWindow] = useState(model.contextWindow?.toString() ?? "");
  const [maxOutput, setMaxOutput] = useState(model.maxOutputTokens?.toString() ?? "");
  const [inputPrice, setInputPrice] = useState(model.inputPricePerMtok?.toString() ?? "");
  const [cachedPrice, setCachedPrice] = useState(model.inputPriceCachedPerMtok?.toString() ?? "");
  const [outputPrice, setOutputPrice] = useState(model.outputPricePerMtok?.toString() ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const is = { background: styles.inputBg, borderColor: styles.inputBorder, color: styles.text } as const;
  const small = "h-9 w-full rounded-lg border-[1.5px] px-2.5 text-[12px] font-mono outline-none";

  const save = async () => {
    if (saving) return;
    setSaving(true); setError(null);
    try {
      await api(`/models/${model.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          displayName: displayName.trim() || model.modelId,
          ...(contextWindow !== "" ? { contextWindow: Number(contextWindow) } : { contextWindow: null }),
          ...(maxOutput !== "" ? { maxOutputTokens: Number(maxOutput) } : { maxOutputTokens: null }),
          ...(inputPrice !== "" ? { inputPricePerMtok: Number(inputPrice) } : { inputPricePerMtok: null }),
          ...(cachedPrice !== "" ? { inputPriceCachedPerMtok: Number(cachedPrice) } : { inputPriceCachedPerMtok: null }),
          ...(outputPrice !== "" ? { outputPricePerMtok: Number(outputPrice) } : { outputPricePerMtok: null }),
        }),
      });
      onSaved(); onClose();
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to save"); }
    finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center" style={{ background: "rgba(0,0,0,0.5)" }} onClick={onClose}>
      <div className="max-h-[85vh] w-[min(440px,92vw)] overflow-y-auto rounded-[16px] border-[1.5px] p-5"
        style={{ background: styles.card, borderColor: styles.borderStrong }} onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-1 text-[16px] font-bold" style={{ color: styles.text }}>Edit Model</h3>
        <p className="mb-4 text-[10px] font-mono" style={{ color: styles.textTertiary }}>{model.modelId}</p>
        <div className="flex flex-col gap-3">
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Display name" className={small} style={is} autoFocus />
          <div className="grid grid-cols-2 gap-2">
            <input value={contextWindow} onChange={(e) => setContextWindow(e.target.value.replace(/[^0-9]/g, ""))}
              placeholder="Context window" className={small} style={is} inputMode="numeric" />
            <input value={maxOutput} onChange={(e) => setMaxOutput(e.target.value.replace(/[^0-9]/g, ""))}
              placeholder="Max output tokens" className={small} style={is} inputMode="numeric" />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <input value={inputPrice} onChange={(e) => setInputPrice(e.target.value.replace(/[^0-9.]/g, ""))}
              placeholder="$/Mt in" className={small} style={is} inputMode="decimal" />
            <input value={cachedPrice} onChange={(e) => setCachedPrice(e.target.value.replace(/[^0-9.]/g, ""))}
              placeholder="$/Mt cached" className={small} style={is} inputMode="decimal" />
            <input value={outputPrice} onChange={(e) => setOutputPrice(e.target.value.replace(/[^0-9.]/g, ""))}
              placeholder="$/Mt out" className={small} style={is} inputMode="decimal" />
          </div>
          {error && <p className="text-[11px]" style={{ color: "#ef4444" }}>{error}</p>}
          <div className="mt-1 flex gap-2">
            <button onClick={onClose} className="flex-1 rounded-lg border-[1.5px] py-2.5 text-[12px] font-semibold"
              style={{ background: styles.inputBg, color: styles.textSecondary, borderColor: styles.border }}>Cancel</button>
            <button onClick={() => void save()} disabled={saving}
              className="flex-1 rounded-lg py-2.5 text-[12px] font-semibold disabled:opacity-50"
              style={{ background: styles.accent, color: styles.accentText }}>
              {saving ? "Saving…" : "Save Changes"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
